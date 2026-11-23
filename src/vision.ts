import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import {
  buildClipboardImageAttachment,
  readImageFromClipboard,
  sniffImageDimensions,
  sniffImageMimeType,
  type ClipboardImageAttachment,
  type RawClipboardImage,
} from "./clipboard.js";
import type { ChatImageBlock } from "./model.js";
import { TARGET_EXTENSIONS, resolveTargetPath } from "./target.js";

export type ScreenshotMode =
  | "desktop"
  | "region"
  | "window"
  | "browser"
  | "adb"
  | "binary";

export interface ImageForensicsReport {
  readonly mimeType: string;
  readonly byteLength: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly sha256: string;
  readonly sourcePath: string | null;
  readonly textChunks: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly printableStrings: readonly string[];
}

export interface CapturedScreenshot {
  readonly path: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
  readonly width: number | null;
  readonly height: number | null;
  readonly source: string;
  readonly mode: ScreenshotMode;
  readonly summary: string;
}

export interface MentionFileBlock {
  readonly displayPath: string;
  readonly resolvedPath: string;
  readonly lineRange: string | null;
  readonly content: string;
  readonly truncated: boolean;
}

export interface ExtractedPromptMentions {
  readonly cleanedPrompt: string;
  readonly contextAppendix: string | null;
  readonly images: ClipboardImageAttachment[];
  readonly fileBlocks: MentionFileBlock[];
}

export interface AtMentionCandidate {
  readonly token: string;
  readonly replacement: string;
  readonly display: string;
  readonly kind: "image" | "binary" | "file" | "dir";
  readonly badge: "IMG" | "BIN" | "FILE" | "DIR";
  readonly description: string;
}

const IMAGE_FILE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
]);

export const isImageFilePath = (filePath: string): boolean =>
  IMAGE_FILE_EXTENSIONS.has(extname(filePath).toLowerCase());

const MAX_MENTION_FILE_BYTES = 256 * 1024;
const MAX_MENTION_TEXT_CHARS = 24_000;
const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024;

// Precomputed IEEE 802.3 CRC32 table for PNG chunk framing.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (type: Buffer, data: Buffer): number => {
  let c = 0xffffffff;
  for (let i = 0; i < type.length; i += 1) {
    c = CRC_TABLE[(c ^ type[i]!) & 0xff]! ^ (c >>> 8);
  }
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (typeAscii: string, data: Buffer): Buffer => {
  const type = Buffer.from(typeAscii, "ascii");
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  type.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(type, data), 8 + data.length);
  return out;
};

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Format an OSC 8 clickable terminal hyperlink (`file://...`) matching `omp`'s `imageReferenceHyperlink`.
 */
export const osc8FileLink = (
  filePath: string | null | undefined,
  label: string,
): string => {
  if (!filePath) return label;
  try {
    const href = pathToFileURL(filePath).href;
    return `\x1b]8;;${href}\x07${label}\x1b]8;;\x07`;
  } catch {
    return label;
  }
};

/**
 * Encode a 24-bit RGB pixel buffer (`width * height * 3` bytes) into a valid PNG image
 * with optional `tEXt` metadata chunks.
 */
export const encodeRgbPng = (
  width: number,
  height: number,
  rgb: Uint8Array,
  textChunks?: Readonly<Record<string, string>>,
): Buffer => {
  const w = Math.max(1, Math.trunc(width));
  const h = Math.max(1, Math.trunc(height));
  const rowBytes = w * 3;
  const stride = 1 + rowBytes;
  const rawScanlines = Buffer.allocUnsafe(h * stride);

  for (let y = 0; y < h; y += 1) {
    const dstRow = y * stride;
    rawScanlines[dstRow] = 0; // Filter type 0 (None)
    const srcRow = y * rowBytes;
    for (let i = 0; i < rowBytes; i += 1) {
      rawScanlines[dstRow + 1 + i] = rgb[srcRow + i] ?? 0;
    }
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 2; // color type 2 (Truecolor RGB)
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const chunks: Buffer[] = [PNG_SIGNATURE, pngChunk("IHDR", ihdr)];
  if (textChunks) {
    for (const [k, v] of Object.entries(textChunks)) {
      const keyClean = k.replace(/[^\x20-\x7e]/g, "").slice(0, 79);
      const valClean = v.replace(/[^\x20-\x7e]/g, "").slice(0, 500);
      if (!keyClean) continue;
      const payload = Buffer.concat([
        Buffer.from(keyClean, "ascii"),
        Buffer.from([0]),
        Buffer.from(valClean, "ascii"),
      ]);
      chunks.push(pngChunk("tEXt", payload));
    }
  }
  const compressed = deflateSync(rawScanlines, { level: 6 });
  chunks.push(pngChunk("IDAT", compressed));
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
};

const paethPredictor = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
};

/**
 * Pure Node.js PNG decoder (`zlib.inflateSync` + scanline unfiltering) for rendering
 * truecolor ANSI half-block (`▀`) terminal previews without any native binary dependency.
 */
export const decodePngRgba = (
  bytes: Buffer,
): { width: number; height: number; rgba: Uint8Array } | null => {
  if (bytes.length < 33) return null;
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idatParts: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) break;
    const chunk = bytes.subarray(dataStart, dataEnd);

    if (type === "IHDR" && chunk.length >= 13) {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8]!;
      colorType = chunk[9]!;
      interlace = chunk[12]!;
    } else if (type === "PLTE") {
      palette = chunk;
    } else if (type === "tRNS") {
      trns = chunk;
    } else if (type === "IDAT") {
      idatParts.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (
    width <= 0 ||
    height <= 0 ||
    width > 8192 ||
    height > 8192 ||
    interlace !== 0 ||
    idatParts.length === 0
  ) {
    return null;
  }

  const channels =
    colorType === 0
      ? 1
      : colorType === 2
        ? 3
        : colorType === 3
          ? 1
          : colorType === 4
            ? 2
            : colorType === 6
              ? 4
              : 0;
  if (channels === 0) return null;
  if (bitDepth !== 8 && !(bitDepth === 1 && (colorType === 0 || colorType === 3))) {
    return null;
  }

  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idatParts), {
      maxOutputLength: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }

  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const rowBytes =
    bitDepth === 1 ? Math.ceil(width / 8) : width * channels * (bitDepth / 8);
  const stride = 1 + rowBytes;
  if (inflated.length < height * stride) return null;

  const unfiltered = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * stride]!;
    const srcOff = y * stride + 1;
    const dstOff = y * rowBytes;
    const prevOff = (y - 1) * rowBytes;

    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[srcOff + x]!;
      const left = x >= bpp ? unfiltered[dstOff + x - bpp]! : 0;
      const up = y > 0 ? unfiltered[prevOff + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? unfiltered[prevOff + x - bpp]! : 0;

      let val = raw;
      if (filter === 1) val = (raw + left) & 0xff;
      else if (filter === 2) val = (raw + up) & 0xff;
      else if (filter === 3) val = (raw + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) val = (raw + paethPredictor(left, up, upLeft)) & 0xff;
      unfiltered[dstOff + x] = val;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const rowOff = y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const outIdx = (y * width + x) * 4;
      if (bitDepth === 1) {
        const bit = (unfiltered[rowOff + (x >> 3)]! >> (7 - (x & 7))) & 1;
        if (colorType === 3 && palette && palette.length >= (bit + 1) * 3) {
          rgba[outIdx] = palette[bit * 3]!;
          rgba[outIdx + 1] = palette[bit * 3 + 1]!;
          rgba[outIdx + 2] = palette[bit * 3 + 2]!;
          rgba[outIdx + 3] = 255;
        } else {
          const v = bit ? 255 : 0;
          rgba[outIdx] = v;
          rgba[outIdx + 1] = v;
          rgba[outIdx + 2] = v;
          rgba[outIdx + 3] = 255;
        }
      } else if (colorType === 0) {
        const g = unfiltered[rowOff + x]!;
        rgba[outIdx] = g;
        rgba[outIdx + 1] = g;
        rgba[outIdx + 2] = g;
        rgba[outIdx + 3] = 255;
      } else if (colorType === 2) {
        const p = rowOff + x * 3;
        rgba[outIdx] = unfiltered[p]!;
        rgba[outIdx + 1] = unfiltered[p + 1]!;
        rgba[outIdx + 2] = unfiltered[p + 2]!;
        rgba[outIdx + 3] = 255;
      } else if (colorType === 3) {
        const idx = unfiltered[rowOff + x]!;
        if (palette && (idx + 1) * 3 <= palette.length) {
          rgba[outIdx] = palette[idx * 3]!;
          rgba[outIdx + 1] = palette[idx * 3 + 1]!;
          rgba[outIdx + 2] = palette[idx * 3 + 2]!;
        }
        rgba[outIdx + 3] = trns && idx < trns.length ? trns[idx]! : 255;
      } else if (colorType === 4) {
        const p = rowOff + x * 2;
        const g = unfiltered[p]!;
        rgba[outIdx] = g;
        rgba[outIdx + 1] = g;
        rgba[outIdx + 2] = g;
        rgba[outIdx + 3] = unfiltered[p + 1]!;
      } else if (colorType === 6) {
        const p = rowOff + x * 4;
        rgba[outIdx] = unfiltered[p]!;
        rgba[outIdx + 1] = unfiltered[p + 1]!;
        rgba[outIdx + 2] = unfiltered[p + 2]!;
        rgba[outIdx + 3] = unfiltered[p + 3]!;
      }
    }
  }

  return { width, height, rgba };
};

/**
 * Transcode an uncompressed 24-bit or 32-bit BMP image buffer into a valid PNG buffer.
 */
export const transcodeBmpToPng = (bmp: Buffer): Buffer | null => {
  if (bmp.length < 54 || bmp[0] !== 0x42 || bmp[1] !== 0x4d) return null;
  const pixelOffset = bmp.readUInt32LE(10);
  const dibSize = bmp.readUInt32LE(14);
  if (dibSize < 40 || pixelOffset >= bmp.length) return null;
  const width = bmp.readInt32LE(18);
  const rawHeight = bmp.readInt32LE(22);
  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  const bpp = bmp.readUInt16LE(28);
  const compression = bmp.readUInt32LE(30);
  if (
    width <= 0 ||
    height <= 0 ||
    width > 4096 ||
    height > 4096 ||
    compression !== 0 ||
    (bpp !== 24 && bpp !== 32)
  ) {
    return null;
  }
  const bytesPerPixel = bpp / 8;
  const rowStride = Math.floor((width * bytesPerPixel + 3) / 4) * 4;
  if (pixelOffset + rowStride * height > bmp.length) return null;

  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const srcY = topDown ? y : height - 1 - y;
    const srcRow = pixelOffset + srcY * rowStride;
    const dstRow = y * width * 3;
    for (let x = 0; x < width; x += 1) {
      const b = bmp[srcRow + x * bytesPerPixel]!;
      const g = bmp[srcRow + x * bytesPerPixel + 1]!;
      const r = bmp[srcRow + x * bytesPerPixel + 2]!;
      rgb[dstRow + x * 3] = r;
      rgb[dstRow + x * 3 + 1] = g;
      rgb[dstRow + x * 3 + 2] = b;
    }
  }
  return encodeRgbPng(width, height, rgb);
};

/**
 * Render a 24-bit ANSI truecolor half-block (`▀`) terminal preview of an image buffer.
 */
export const renderAnsiImagePreview = (
  bytes: Buffer,
  options?: {
    readonly maxCols?: number;
    readonly maxRows?: number;
    readonly filePath?: string | null;
    readonly label?: string;
  },
): string[] => {
  const maxCols = Math.max(8, Math.min(72, options?.maxCols ?? 36));
  const maxRows = Math.max(3, Math.min(20, options?.maxRows ?? 10));
  const decoded = decodePngRgba(bytes);
  const dims = decoded
    ? { width: decoded.width, height: decoded.height }
    : sniffImageDimensions(bytes);
  const mime = sniffImageMimeType(bytes) ?? "image/png";
  const kb = Math.max(1, Math.round(bytes.length / 1024));
  const dimLabel = dims ? `${dims.width}×${dims.height}` : "unknown dims";
  const headerTitle =
    options?.label ??
    `${mime.replace("image/", "").toUpperCase()} · ${dimLabel} · ${kb} KB`;
  const linkPart = options?.filePath
    ? ` · ${osc8FileLink(options.filePath, options.filePath)}`
    : "";

  const lines: string[] = [`🖼  ${headerTitle}${linkPart}`];
  if (!decoded) {
    return lines;
  }

  // Each terminal cell is ~1:2 aspect ratio, and each half-block row packs 2 vertical pixels!
  const aspect = decoded.width / Math.max(1, decoded.height);
  let targetCols = Math.min(maxCols, decoded.width);
  let targetPixelRows = Math.max(
    2,
    Math.round(targetCols / Math.max(0.1, aspect)),
  );
  if (Math.ceil(targetPixelRows / 2) > maxRows) {
    targetPixelRows = maxRows * 2;
    targetCols = Math.max(
      4,
      Math.min(maxCols, Math.round(targetPixelRows * aspect)),
    );
  }
  if (targetPixelRows % 2 !== 0) targetPixelRows += 1;
  const charRows = Math.max(1, targetPixelRows / 2);

  const samplePixel = (px: number, py: number): [number, number, number] => {
    const sx = Math.min(
      decoded.width - 1,
      Math.max(0, Math.floor((px / targetCols) * decoded.width)),
    );
    const sy = Math.min(
      decoded.height - 1,
      Math.max(0, Math.floor((py / targetPixelRows) * decoded.height)),
    );
    const idx = (sy * decoded.width + sx) * 4;
    const a = decoded.rgba[idx + 3]! / 255;
    // Composite over dark slate background (#12161f)
    const r = Math.round(decoded.rgba[idx]! * a + 18 * (1 - a));
    const g = Math.round(decoded.rgba[idx + 1]! * a + 22 * (1 - a));
    const b = Math.round(decoded.rgba[idx + 2]! * a + 31 * (1 - a));
    return [r, g, b];
  };

  for (let row = 0; row < charRows; row += 1) {
    let rowAnsi = "  ";
    for (let col = 0; col < targetCols; col += 1) {
      const [tr, tg, tb] = samplePixel(col, row * 2);
      const [br, bg, bb] = samplePixel(col, row * 2 + 1);
      rowAnsi += `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg};${bb}m▀`;
    }
    rowAnsi += "\x1b[0m";
    lines.push(rowAnsi);
  }
  return lines;
};

/**
 * Inspect an image buffer for forensic metadata: dimensions, SHA-256, PNG `tEXt`/`iTXt`
 * chunks, and embedded printable ASCII strings.
 */
export const inspectImageForensics = (
  bytes: Buffer,
  mimeType?: string | null,
  sourcePath?: string | null,
): ImageForensicsReport => {
  const resolvedMime =
    sniffImageMimeType(bytes) ?? mimeType ?? "application/octet-stream";
  const dims = sniffImageDimensions(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const textChunks: Array<{ key: string; value: string }> = [];

  if (
    bytes.length >= 33 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const len = bytes.readUInt32BE(offset);
      const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
      const dataStart = offset + 8;
      const dataEnd = dataStart + len;
      if (dataEnd + 4 > bytes.length) break;
      const chunk = bytes.subarray(dataStart, dataEnd);
      if (type === "tEXt" || type === "iTXt") {
        const nul = chunk.indexOf(0);
        if (nul > 0) {
          const key = chunk.subarray(0, nul).toString("utf8").trim();
          const val = chunk
            .subarray(nul + 1)
            .toString("utf8")
            .replace(/\0+/g, " ")
            .trim();
          if (key && val) {
            textChunks.push({ key, value: val.slice(0, 300) });
          }
        }
      } else if (type === "IEND") {
        break;
      }
      offset = dataEnd + 4;
    }
  }

  // Extract notable printable ASCII runs (>= 6 chars) from header/trailer/metadata
  const printableStrings: string[] = [];
  const scanWindow =
    bytes.length <= 65_536
      ? bytes
      : Buffer.concat([bytes.subarray(0, 32_768), bytes.subarray(-32_768)]);
  const ascii = scanWindow.toString("latin1");
  const matches = ascii.match(/[\x20-\x7e]{6,120}/g) ?? [];
  const noise = new Set(["IHDR", "IDAT", "IEND", "PLTE", "tRNS", "JFIF", "Exif"]);
  for (const raw of matches) {
    const trimmed = raw.trim();
    if (trimmed.length < 6 || noise.has(trimmed)) continue;
    // Skip high-punctuation random noise from compressed streams
    const alnum = (trimmed.match(/[A-Za-z0-9_./:-]/g) ?? []).length;
    if (alnum / trimmed.length < 0.72) continue;
    if (!printableStrings.includes(trimmed)) {
      printableStrings.push(trimmed);
      if (printableStrings.length >= 16) break;
    }
  }

  return {
    mimeType: resolvedMime,
    byteLength: bytes.length,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    sha256,
    sourcePath: sourcePath ?? null,
    textChunks,
    printableStrings,
  };
};

/**
 * Build a rich text fallback summary when a text-only LLM endpoint rejects `image_url` / `image`
 * blocks with HTTP 400/422 (`omp` `image-vision-fallback` parity + forensic upgrade).
 */
export const describeAttachedImagesFallback = (
  images: readonly ChatImageBlock[],
): string => {
  if (images.length === 0) return "";
  const blocks: string[] = [];
  for (let i = 0; i < images.length; i += 1) {
    const img = images[i]!;
    try {
      const bytes = Buffer.from(img.data, "base64");
      const info = inspectImageForensics(bytes, img.mimeType);
      const dims =
        info.width && info.height ? `${info.width}×${info.height}px` : "unknown-dims";
      const kb = Math.max(1, Math.round(info.byteLength / 1024));
      const metaParts = info.textChunks.map((c) => `${c.key}="${c.value}"`);
      const strParts = info.printableStrings.slice(0, 8);
      const lines = [
        `[Attached Image #${i + 1} (vision fallback for text-only endpoint): ${info.mimeType} · ${dims} · ${kb} KB · sha256:${info.sha256.slice(0, 16)}]`,
      ];
      if (metaParts.length > 0) {
        lines.push(`  metadata: ${metaParts.join("; ")}`);
      }
      if (strParts.length > 0) {
        lines.push(`  embedded_strings: ${strParts.join(" | ")}`);
      }
      blocks.push(lines.join("\n"));
    } catch {
      blocks.push(
        `[Attached Image #${i + 1}: ${img.mimeType} (${Math.round((img.data.length * 3) / 4 / 1024)} KB)]`,
      );
    }
  }
  return blocks.join("\n");
};

/**
 * Load an image from a local file path, `file://` URI, `data:image/...` URI,
 * remote `http(s)://` URL, or `"clipboard"`.
 */
export const loadImageSource = async (
  spec: string,
  options?: {
    readonly cwd?: string | undefined;
    readonly sessionDir?: string | null | undefined;
    readonly timeoutMs?: number | undefined;
  },
): Promise<RawClipboardImage> => {
  const cwd = options?.cwd ?? process.cwd();
  const trimmed = spec.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) {
    throw new Error("Empty image source specification.");
  }

  const lower = trimmed.toLowerCase();
  if (lower === "clipboard" || lower === "paste" || lower === "clip") {
    const clip = await readImageFromClipboard(cwd);
    if (!clip) {
      throw new Error(
        "No image found in system clipboard (copy an image or screenshot first, or pass a file path).",
      );
    }
    return clip;
  }

  if (lower.startsWith("data:image/")) {
    const comma = trimmed.indexOf(",");
    if (comma < 0) throw new Error("Malformed data:image/ URL.");
    const header = trimmed.slice(5, comma);
    const mimeType = header.split(";")[0]?.trim() || "image/png";
    const bytes = Buffer.from(trimmed.slice(comma + 1), "base64");
    if (bytes.length === 0) throw new Error("Empty data:image/ payload.");
    return { mimeType, bytes, sourcePath: null };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options?.timeoutMs ?? 12_000,
    );
    timer.unref?.();
    try {
      const res = await fetch(trimmed, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching image from ${trimmed}`);
      }
      const arrayBuf = await res.arrayBuffer();
      const bytes = Buffer.from(arrayBuf);
      if (bytes.length === 0 || bytes.length > MAX_REMOTE_IMAGE_BYTES) {
        throw new Error(
          `Invalid remote image size (${bytes.length} bytes) from ${trimmed}`,
        );
      }
      let finalBytes: Buffer = bytes;
      let mime =
        sniffImageMimeType(bytes) ??
        res.headers.get("content-type")?.split(";")[0]?.trim() ??
        "image/png";
      if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
        const png = transcodeBmpToPng(bytes);
        if (png) {
          finalBytes = png;
          mime = "image/png";
        }
      }
      let savedPath: string | null = null;
      if (options?.sessionDir) {
        try {
          const dir = join(options.sessionDir, "attachments");
          await mkdir(dir, { recursive: true });
          const hash = createHash("sha256")
            .update(finalBytes)
            .digest("hex")
            .slice(0, 10);
          const ext =
            mime === "image/jpeg"
              ? "jpg"
              : mime === "image/webp"
                ? "webp"
                : mime === "image/gif"
                  ? "gif"
                  : "png";
          savedPath = join(dir, `remote-image-${hash}.${ext}`);
          await writeFile(savedPath, finalBytes);
        } catch {
          savedPath = null;
        }
      }
      return { mimeType: mime, bytes: finalBytes, sourcePath: savedPath };
    } finally {
      clearTimeout(timer);
    }
  }

  let candidate = trimmed;
  if (candidate.startsWith("file://")) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
    } catch {
      candidate = candidate.slice("file://".length);
    }
  }
  const resolved = resolveTargetPath(candidate, cwd);
  if (!resolved || !existsSync(resolved)) {
    throw new Error(`Image file not found: ${trimmed}`);
  }
  const st = statSync(resolved);
  if (!st.isFile() || st.size <= 0 || st.size > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error(`Invalid or oversized image file: ${resolved}`);
  }
  const rawBytes = readFileSync(resolved);
  if (rawBytes[0] === 0x42 && rawBytes[1] === 0x4d) {
    const transcoded = transcodeBmpToPng(rawBytes);
    if (transcoded) {
      return {
        mimeType: "image/png",
        bytes: transcoded,
        sourcePath: resolved,
      };
    }
  }
  const sniffed = sniffImageMimeType(rawBytes);
  const ext = extname(resolved).toLowerCase();
  const mime =
    sniffed ??
    (ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".gif"
          ? "image/gif"
          : IMAGE_FILE_EXTENSIONS.has(ext)
            ? "image/png"
            : null);
  if (!mime) {
    throw new Error(
      `File "${resolved}" is not a supported image (expected PNG, JPEG, WebP, GIF, or BMP).`,
    );
  }
  return { mimeType: mime, bytes: rawBytes, sourcePath: resolved };
};

/**
 * Render a 2D RGB Visual Binary Entropy & Byte-Class Heatmap PNG (`640×360`) of any binary file
 * so vision-capable LLMs (and analysts) can visually spot packed/encrypted sections, padding,
 * embedded bitmaps/resources, and code/data boundaries.
 */
export const renderBinaryVisualForensicsPng = async (
  targetPath: string,
  outputDir: string,
): Promise<{
  readonly path: string;
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly summary: string;
  readonly peakEntropy: number;
  readonly avgEntropy: number;
}> => {
  const st = statSync(targetPath);
  const totalBytes = st.size;
  const raw = readFileSync(targetPath);
  const width = 640;
  const height = 360;
  const rgb = new Uint8Array(width * height * 3);

  // Dark cyber background (#0d1117)
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = 13;
    rgb[i * 3 + 1] = 17;
    rgb[i * 3 + 2] = 23;
  }

  const setPixel = (
    x: number,
    y: number,
    r: number,
    g: number,
    b: number,
  ): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = (y * width + x) * 3;
    rgb[idx] = r;
    rgb[idx + 1] = g;
    rgb[idx + 2] = b;
  };

  // Layout:
  // Left pane (x: 16..399, y: 24..335 -> 384×312): 2D Byte-Class & Density Map
  // Right pane (x: 416..623, y: 24..335 -> 208×312): Sliding-Window Shannon Entropy Profile (0..8 bits/byte)
  const mapX0 = 16;
  const mapY0 = 24;
  const mapW = 384;
  const mapH = 312;
  const entX0 = 416;
  const entW = 208;

  // Draw panel borders (#30363d)
  for (let x = mapX0 - 1; x <= mapX0 + mapW; x += 1) {
    setPixel(x, mapY0 - 1, 48, 54, 61);
    setPixel(x, mapY0 + mapH, 48, 54, 61);
  }
  for (let x = entX0 - 1; x <= entX0 + entW; x += 1) {
    setPixel(x, mapY0 - 1, 48, 54, 61);
    setPixel(x, mapY0 + mapH, 48, 54, 61);
  }
  for (let y = mapY0 - 1; y <= mapY0 + mapH; y += 1) {
    setPixel(mapX0 - 1, y, 48, 54, 61);
    setPixel(mapX0 + mapW, y, 48, 54, 61);
    setPixel(entX0 - 1, y, 48, 54, 61);
    setPixel(entX0 + entW, y, 48, 54, 61);
  }

  let nullCount = 0;
  let asciiCount = 0;
  let highByteCount = 0;

  // Fill 2D Byte-Class Matrix
  if (raw.length > 0) {
    const totalCells = mapW * mapH;
    for (let row = 0; row < mapH; row += 1) {
      for (let col = 0; col < mapW; col += 1) {
        const cellIndex = row * mapW + col;
        const byteOffset = Math.min(
          raw.length - 1,
          Math.floor((cellIndex / totalCells) * raw.length),
        );
        const b = raw[byteOffset]!;
        let r = 20;
        let g = 26;
        let bl = 36;
        if (b === 0x00) {
          nullCount += 1;
          r = 18;
          g = 24;
          bl = 34;
        } else if (b === 0xff) {
          highByteCount += 1;
          r = 245;
          g = 158;
          bl = 11; // Amber padding/erased flash
        } else if (b >= 0x20 && b <= 0x7e) {
          asciiCount += 1;
          // Printable ASCII -> Neon Cyan (#22d3ee)
          const boost = Math.round(((b - 0x20) / 94) * 60);
          r = 24;
          g = 150 + boost;
          bl = 195 + Math.min(60, boost);
        } else if (b < 0x20) {
          // Control / low opcodes -> Emerald (#10b981)
          r = 16;
          g = 120 + b * 3;
          bl = 95;
        } else {
          // High bytes (0x80..0xFE: code/compressed/encrypted) -> Violet/Magenta gradient
          highByteCount += 1;
          const norm = (b - 0x80) / 126;
          r = Math.round(110 + norm * 130);
          g = Math.round(50 + norm * 30);
          bl = Math.round(180 + norm * 65);
        }
        setPixel(mapX0 + col, mapY0 + row, r, g, bl);
      }
    }
  }

  // Compute row-by-row Shannon entropy (0..8 bits/byte) and draw profile
  let entropySum = 0;
  let peakEntropy = 0;
  let highEntropyRows = 0;
  const counts = new Uint32Array(256);

  // 7.2 bits/byte threshold line in right panel
  const threshX = entX0 + Math.round((7.2 / 8.0) * (entW - 1));
  for (let y = 0; y < mapH; y += 2) {
    setPixel(threshX, mapY0 + y, 120, 45, 60);
  }

  for (let row = 0; row < mapH; row += 1) {
    counts.fill(0);
    const startOff = Math.floor((row / mapH) * raw.length);
    const endOff = Math.max(
      startOff + 1,
      Math.min(raw.length, Math.floor(((row + 1) / mapH) * raw.length)),
    );
    const span = Math.max(1, endOff - startOff);
    const step = span > 2048 ? Math.floor(span / 2048) : 1;
    let samples = 0;
    for (let i = startOff; i < endOff; i += step) {
      counts[raw[i]!]! += 1;
      samples += 1;
    }
    let ent = 0;
    if (samples > 0) {
      for (let c = 0; c < 256; c += 1) {
        const cnt = counts[c]!;
        if (cnt === 0) continue;
        const p = cnt / samples;
        ent -= p * Math.log2(p);
      }
    }
    entropySum += ent;
    if (ent > peakEntropy) peakEntropy = ent;
    if (ent >= 7.2) highEntropyRows += 1;

    const barLen = Math.min(
      entW,
      Math.max(1, Math.round((ent / 8.0) * entW)),
    );
    for (let x = 0; x < barLen; x += 1) {
      const ratio = x / entW;
      let r: number;
      let g: number;
      let bl: number;
      if (ent >= 7.2) {
        // High entropy (packed/encrypted) -> Crimson/Coral
        r = 239;
        g = Math.round(68 + (1 - ratio) * 40);
        bl = 68;
      } else if (ent >= 5.5) {
        // Medium-high entropy (native code/rodata) -> Neon Mint/Cyan
        r = 16;
        g = Math.round(165 + ratio * 50);
        bl = Math.round(140 + ratio * 80);
      } else {
        // Low entropy (strings/tables/zeros) -> Cyan/Blue
        r = 30;
        g = Math.round(110 + ratio * 60);
        bl = 210;
      }
      setPixel(entX0 + x, mapY0 + row, r, g, bl);
    }
  }

  const avgEntropy = mapH > 0 ? Number((entropySum / mapH).toFixed(2)) : 0;
  peakEntropy = Number(peakEntropy.toFixed(2));
  const totalSampled = Math.max(1, nullCount + asciiCount + highByteCount);
  const asciiPct = Math.round((asciiCount / totalSampled) * 100);
  const nullPct = Math.round((nullCount / totalSampled) * 100);
  const highEntPct = Math.round((highEntropyRows / mapH) * 100);

  const summary =
    `Binary Visual Forensics Heatmap (${basename(targetPath)} · ${totalBytes.toLocaleString()} bytes): ` +
    `avg_entropy=${avgEntropy}b/B, peak_entropy=${peakEntropy}b/B, ` +
    `high_entropy_regions(>=7.2)=${highEntPct}%, printable_ascii=${asciiPct}%, null_padding=${nullPct}%`;

  const pngBytes = encodeRgbPng(width, height, rgb, {
    Title: `OMR Binary Visual Forensics - ${basename(targetPath)}`,
    Summary: summary,
  });

  await mkdir(outputDir, { recursive: true });
  const safeBase = basename(targetPath).replace(/[^A-Za-z0-9._-]/g, "_");
  const outPath = join(outputDir, `binary-vision-${safeBase}.png`);
  await writeFile(outPath, pngBytes);

  return {
    path: outPath,
    bytes: pngBytes,
    width,
    height,
    summary,
    peakEntropy,
    avgEntropy,
  };
};

const execCmd = (
  cmd: string,
  args: readonly string[],
  timeoutMs = 12_000,
): Promise<{ ok: boolean; stdout: Buffer; stderr: string }> =>
  new Promise((resolvePromise) => {
    execFile(
      cmd,
      [...args],
      {
        encoding: "buffer",
        timeout: timeoutMs,
        maxBuffer: MAX_REMOTE_IMAGE_BYTES,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        resolvePromise({
          ok: !err,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0),
          stderr: Buffer.isBuffer(stderr)
            ? stderr.toString("utf8")
            : String(stderr ?? ""),
        });
      },
    );
  });

/**
 * Multi-source screenshot engine supporting Desktop (`desktop` | `region` | `window`),
 * Android (`adb`), Browser (`browser`), and Binary Visual Forensics (`binary`).
 */
export const captureScreenshot = async (options: {
  readonly mode?: ScreenshotMode;
  readonly outputDir: string;
  readonly cwd?: string;
  readonly targetPath?: string | null;
  readonly url?: string | null;
  readonly browserCapture?: () => Promise<{
    readonly path?: string | null;
    readonly bytes?: Buffer | null;
    readonly source?: string;
  } | null>;
}): Promise<CapturedScreenshot> => {
  const mode: ScreenshotMode = options.mode ?? "desktop";
  const outputDir = options.outputDir;
  await mkdir(outputDir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);

  // 1. Binary Visual Forensics Heatmap (`binary`)
  if (mode === "binary") {
    const target = options.targetPath;
    if (!target || !existsSync(target)) {
      throw new Error(
        "No target binary is bound or specified for `/screenshot binary`. Open a target with `/open <path>` or pass `/screenshot binary <path>`.",
      );
    }
    const heatmap = await renderBinaryVisualForensicsPng(target, outputDir);
    return {
      path: heatmap.path,
      mimeType: "image/png",
      bytes: heatmap.bytes,
      width: heatmap.width,
      height: heatmap.height,
      source: "binary-entropy-heatmap",
      mode: "binary",
      summary: heatmap.summary,
    };
  }

  // 2. Android ADB Device Screenshot (`adb`)
  if (mode === "adb") {
    const outPath = join(outputDir, `adb-screen-${stamp}.png`);
    const res = await execCmd("adb", ["exec-out", "screencap", "-p"], 10_000);
    if (!res.ok || res.stdout.length < 24 || !sniffImageMimeType(res.stdout)) {
      throw new Error(
        `ADB screenshot failed: ${res.stderr.trim() || "no connected Android device or adb not found"}`,
      );
    }
    await writeFile(outPath, res.stdout);
    const dims = sniffImageDimensions(res.stdout);
    return {
      path: outPath,
      mimeType: "image/png",
      bytes: res.stdout,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      source: "adb:screencap",
      mode: "adb",
      summary: `Captured Android device screen via ADB (${dims ? `${dims.width}×${dims.height}` : `${Math.round(res.stdout.length / 1024)} KB`})`,
    };
  }

  // 3. Browser Screenshot (`browser`)
  if (mode === "browser") {
    if (options.browserCapture) {
      const captured = await options.browserCapture();
      if (captured?.bytes && captured.bytes.length > 0) {
        const outPath =
          captured.path ?? join(outputDir, `browser-${stamp}.png`);
        if (!captured.path) await writeFile(outPath, captured.bytes);
        const dims = sniffImageDimensions(captured.bytes);
        return {
          path: outPath,
          mimeType: sniffImageMimeType(captured.bytes) ?? "image/png",
          bytes: captured.bytes,
          width: dims?.width ?? null,
          height: dims?.height ?? null,
          source: captured.source ?? "browser",
          mode: "browser",
          summary: `Captured browser viewport screenshot (${dims ? `${dims.width}×${dims.height}` : `${Math.round(captured.bytes.length / 1024)} KB`})`,
        };
      }
    }
    // Headless Chromium CLI fallback if a URL was passed
    if (options.url) {
      const outPath = join(outputDir, `browser-${stamp}.png`);
      for (const bin of [
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
        "brave-browser",
      ]) {
        const res = await execCmd(
          bin,
          [
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--window-size=1440,900",
            `--screenshot=${outPath}`,
            options.url,
          ],
          15_000,
        );
        if (res.ok && existsSync(outPath)) {
          const bytes = readFileSync(outPath);
          const dims = sniffImageDimensions(bytes);
          return {
            path: outPath,
            mimeType: "image/png",
            bytes,
            width: dims?.width ?? null,
            height: dims?.height ?? null,
            source: `${bin}:headless`,
            mode: "browser",
            summary: `Captured ${options.url} via ${bin} (${dims ? `${dims.width}×${dims.height}` : `${Math.round(bytes.length / 1024)} KB`})`,
          };
        }
      }
    }
    throw new Error(
      "No active browser tab or URL to screenshot. Start a browser with `/browser chromium <url>` or pass `/screenshot browser https://...`.",
    );
  }

  // 4. Desktop / Region / Window Screenshot
  const outPath = join(outputDir, `screenshot-${mode}-${stamp}.png`);
  const candidates: Array<{
    label: string;
    cmd: string;
    args: string[];
    timeoutMs?: number;
  }> = [];

  if (process.platform === "darwin") {
    candidates.push({
      label: "screencapture",
      cmd: "screencapture",
      args:
        mode === "region"
          ? ["-i", "-x", outPath]
          : mode === "window"
            ? ["-w", "-x", outPath]
            : ["-x", outPath],
      timeoutMs: mode === "region" ? 30_000 : 8_000,
    });
  } else if (process.platform === "linux") {
    // KDE Plasma spectacle (non-interactive background flag `-b -n`)
    const spModeFlag =
      mode === "region" ? "-r" : mode === "window" ? "-a" : "-f";
    candidates.push({
      label: "spectacle",
      cmd: "spectacle",
      args: ["-b", "-n", spModeFlag, "-o", outPath],
      timeoutMs: mode === "region" ? 30_000 : 10_000,
    });

    if (process.env["WAYLAND_DISPLAY"]) {
      if (mode === "region") {
        candidates.push({
          label: "grim+slurp",
          cmd: "sh",
          args: ["-c", `grim -g "$(slurp)" "${outPath}"`],
          timeoutMs: 30_000,
        });
      } else {
        candidates.push({
          label: "grim",
          cmd: "grim",
          args: [outPath],
        });
      }
    }

    candidates.push({
      label: "gnome-screenshot",
      cmd: "gnome-screenshot",
      args:
        mode === "region"
          ? ["-a", "-f", outPath]
          : mode === "window"
            ? ["-w", "-f", outPath]
            : ["-f", outPath],
      timeoutMs: mode === "region" ? 30_000 : 10_000,
    });

    candidates.push({
      label: "maim",
      cmd: "maim",
      args: mode === "region" ? ["-s", outPath] : [outPath],
      timeoutMs: mode === "region" ? 30_000 : 8_000,
    });

    candidates.push({
      label: "scrot",
      cmd: "scrot",
      args:
        mode === "region"
          ? ["-s", outPath]
          : mode === "window"
            ? ["-u", outPath]
            : [outPath],
      timeoutMs: mode === "region" ? 30_000 : 8_000,
    });

    candidates.push({
      label: "imagemagick-import",
      cmd: "import",
      args: mode === "region" ? [outPath] : ["-window", "root", outPath],
      timeoutMs: mode === "region" ? 30_000 : 8_000,
    });
  } else if (process.platform === "win32" || process.env["WSL_DISTRO_NAME"]) {
    const psScript =
      "Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;" +
      "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;" +
      "$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height);" +
      "$g=[System.Drawing.Graphics]::FromImage($bmp);" +
      "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);" +
      "$m=New-Object System.IO.MemoryStream;" +
      "$bmp.Save($m,[System.Drawing.Imaging.ImageFormat]::Png);" +
      "[Console]::Out.Write([Convert]::ToBase64String($m.ToArray()))";
    const res = await execCmd(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Sta", "-Command", psScript],
      10_000,
    );
    if (res.ok && res.stdout.length > 0) {
      const bytes = Buffer.from(res.stdout.toString("utf8").trim(), "base64");
      if (bytes.length > 24 && sniffImageMimeType(bytes)) {
        await writeFile(outPath, bytes);
        const dims = sniffImageDimensions(bytes);
        return {
          path: outPath,
          mimeType: "image/png",
          bytes,
          width: dims?.width ?? null,
          height: dims?.height ?? null,
          source: "powershell:CopyFromScreen",
          mode,
          summary: `Captured desktop screenshot (${dims ? `${dims.width}×${dims.height}` : `${Math.round(bytes.length / 1024)} KB`})`,
        };
      }
    }
  }

  for (const cand of candidates) {
    const res = await execCmd(cand.cmd, cand.args, cand.timeoutMs ?? 10_000);
    if (res.ok && existsSync(outPath)) {
      const bytes = readFileSync(outPath);
      if (bytes.length > 24 && sniffImageMimeType(bytes)) {
        const dims = sniffImageDimensions(bytes);
        return {
          path: outPath,
          mimeType: sniffImageMimeType(bytes) ?? "image/png",
          bytes,
          width: dims?.width ?? null,
          height: dims?.height ?? null,
          source: cand.label,
          mode,
          summary: `Captured ${mode} screenshot via ${cand.label} (${dims ? `${dims.width}×${dims.height}` : `${Math.round(bytes.length / 1024)} KB`})`,
        };
      }
    }
  }

  // Fallback: if clipboard already has a freshly copied screenshot, use it!
  const clipImg = await readImageFromClipboard(options.cwd ?? process.cwd());
  if (clipImg && clipImg.bytes.length > 24) {
    await writeFile(outPath, clipImg.bytes);
    const dims = sniffImageDimensions(clipImg.bytes);
    return {
      path: outPath,
      mimeType: clipImg.mimeType,
      bytes: clipImg.bytes,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      source: "clipboard-fallback",
      mode,
      summary: `Captured image from system clipboard (${dims ? `${dims.width}×${dims.height}` : `${Math.round(clipImg.bytes.length / 1024)} KB`})`,
    };
  }

  throw new Error(
    `Could not capture ${mode} screenshot (tried ${candidates.map((c) => c.label).join(", ")}). ` +
      "Install spectacle/grim/maim/scrot, or use `/screenshot binary` for binary visual forensics, or copy an image and press Ctrl+V.",
  );
};

/**
 * Find the active `@mention` token at the cursor in the composer and return matching
 * workspace files, images, binaries, and directories (`omp` `file-mentions` parity).
 */
export const completeAtMention = (
  composer: string,
  cursor: number,
  cwd: string = process.cwd(),
): {
  readonly prefixStart: number;
  readonly token: string;
  readonly candidates: readonly AtMentionCandidate[];
} | null => {
  const before = composer.slice(0, cursor);
  const match = /(?:^|\s)@([^\s]*)$/.exec(before);
  if (!match) return null;
  const rawToken = match[1] ?? "";
  const atIndex = before.lastIndexOf(`@${rawToken}`);
  if (atIndex < 0) return null;

  const clean = rawToken.replace(/^["']/, "");
  const expanded =
    clean === "~"
      ? `${homedir()}/`
      : clean.startsWith("~/")
        ? join(homedir(), clean.slice(2))
        : clean;

  const endsWithSlash =
    expanded.endsWith("/") || expanded.endsWith("\\") || expanded.length === 0;
  const searchDir = endsWithSlash
    ? resolve(cwd, expanded || ".")
    : resolve(cwd, dirname(expanded));
  const prefix = endsWithSlash ? "" : basename(expanded).toLowerCase();
  const displayDirPrefix =
    clean.length === 0
      ? ""
      : endsWithSlash
        ? clean
        : clean.includes("/")
          ? clean.slice(0, clean.lastIndexOf("/") + 1)
          : "";

  let entries;
  try {
    entries = readdirSync(searchDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const scored: Array<{ rank: number; item: AtMentionCandidate }> = [];
  for (const entry of entries.slice(0, 256)) {
    if (!prefix && entry.name.startsWith(".")) continue;
    if (
      prefix &&
      !entry.name.toLowerCase().startsWith(prefix) &&
      !entry.name.toLowerCase().includes(prefix)
    ) {
      continue;
    }
    const isDir = entry.isDirectory();
    const ext = extname(entry.name).toLowerCase();
    const isImg = !isDir && IMAGE_FILE_EXTENSIONS.has(ext);
    const isBin =
      !isDir &&
      TARGET_EXTENSIONS.some((tExt) => entry.name.toLowerCase().endsWith(tExt));

    const suffix = isDir ? "/" : "";
    const relPath = `${displayDirPrefix}${entry.name}${suffix}`;
    const replacement = isDir ? `@${relPath}` : `@${relPath} `;
    const startsExact = !prefix || entry.name.toLowerCase().startsWith(prefix);
    const baseRank = isImg ? 0 : isBin ? 1 : !isDir ? 2 : 3;
    const rank = (startsExact ? 0 : 10) + baseRank;

    let description = "Include file content in prompt context";
    if (isDir) description = "Tab/Enter to browse directory";
    else if (isImg) {
      try {
        const fullPath = resolve(searchDir, entry.name);
        const st = statSync(fullPath);
        const kb = Math.max(1, Math.round(st.size / 1024));
        const head = readFileSync(fullPath).subarray(0, 64);
        const dims = sniffImageDimensions(head);
        description = `Attach image to vision turn (${ext.slice(1).toUpperCase()}${dims ? ` ${dims.width}×${dims.height}` : ""} · ${kb} KB)`;
      } catch {
        description = "Attach image to vision turn";
      }
    } else if (isBin) {
      description = "Binary artifact path reference";
    }

    scored.push({
      rank,
      item: {
        token: rawToken,
        replacement,
        display: `@${relPath}`,
        kind: isImg ? "image" : isBin ? "binary" : isDir ? "dir" : "file",
        badge: isImg ? "IMG" : isBin ? "BIN" : isDir ? "DIR" : "FILE",
        description,
      },
    });
  }

  scored.sort(
    (a, b) => a.rank - b.rank || a.item.display.localeCompare(b.item.display),
  );
  return {
    prefixStart: atIndex,
    token: rawToken,
    candidates: scored.slice(0, 24).map((s) => s.item),
  };
};

/**
 * Extract `@filepath` and `@image.png` mentions (and `@file.ts:10-50` line slices)
 * from a user prompt. Mentioned images are automatically loaded as `ClipboardImageAttachment`s
 * for the vision model, and mentioned text/code files are injected as `<file>` context blocks!
 */
export const extractPromptMentions = async (
  prompt: string,
  cwd: string = process.cwd(),
  sessionDir?: string | null,
  startImageId = 1,
): Promise<ExtractedPromptMentions> => {
  const images: ClipboardImageAttachment[] = [];
  const fileBlocks: MentionFileBlock[] = [];
  let nextId = startImageId;

  // Match `@path/to/file.ext` or `@path/to/file.ext:10-40` (not preceded by email word chars)
  const mentionRegex = /(^|[\s([{"'])@([^\s)\]}"']+)/g;
  const seenPaths = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(prompt)) !== null) {
    const rawSpec = match[2]!;
    // Separate optional `:start-end` or `:line` suffix
    const rangeMatch = /^(.*?):(\d+(?:-\d+)?)$/.exec(rawSpec);
    const filePart = rangeMatch ? rangeMatch[1]! : rawSpec;
    const lineRange = rangeMatch ? rangeMatch[2]! : null;

    const resolved = resolveTargetPath(filePart, cwd);
    if (!resolved || !existsSync(resolved)) continue;

    let st;
    try {
      st = statSync(resolved);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size <= 0) continue;

    const dedupeKey = `${resolved}:${lineRange ?? ""}`;
    if (seenPaths.has(dedupeKey)) continue;
    seenPaths.add(dedupeKey);

    const ext = extname(resolved).toLowerCase();
    if (IMAGE_FILE_EXTENSIONS.has(ext)) {
      try {
        const rawImg = await loadImageSource(resolved, { cwd, sessionDir });
        const att = await buildClipboardImageAttachment(
          nextId++,
          rawImg,
          sessionDir,
        );
        images.push(att);
      } catch {
        // Ignore unreadable image mention
      }
      continue;
    }

    // Skip binary targets from raw text injection
    if (
      TARGET_EXTENSIONS.some((tExt) => resolved.toLowerCase().endsWith(tExt)) ||
      st.size > MAX_MENTION_FILE_BYTES
    ) {
      continue;
    }

    try {
      const buf = readFileSync(resolved);
      // Skip if file contains NUL bytes (binary file)
      if (buf.subarray(0, Math.min(1024, buf.length)).includes(0)) continue;
      let text = buf.toString("utf8").replace(/\r\n/g, "\n");
      if (lineRange) {
        const [startStr, endStr] = lineRange.split("-");
        const startLine = Math.max(1, Number.parseInt(startStr!, 10));
        const endLine = endStr
          ? Math.max(startLine, Number.parseInt(endStr, 10))
          : startLine;
        const allLines = text.split("\n");
        text = allLines
          .slice(startLine - 1, endLine)
          .map((l, idx) => `${startLine + idx}: ${l}`)
          .join("\n");
      }
      const truncated = text.length > MAX_MENTION_TEXT_CHARS;
      const content = truncated
        ? `${text.slice(0, MAX_MENTION_TEXT_CHARS)}\n… [truncated to ${MAX_MENTION_TEXT_CHARS} chars]`
        : text;
      fileBlocks.push({
        displayPath: filePart,
        resolvedPath: resolved,
        lineRange,
        content,
        truncated,
      });
    } catch {
      // Ignore unreadable file
    }
  }

  let contextAppendix: string | null = null;
  if (fileBlocks.length > 0) {
    const rendered = fileBlocks.map((fb) => {
      const rangeAttr = fb.lineRange ? ` lines="${fb.lineRange}"` : "";
      return `<file path="${fb.displayPath}" resolved="${fb.resolvedPath}"${rangeAttr}>\n${fb.content}\n</file>`;
    });
    contextAppendix = `[Attached @file mentions]:\n${rendered.join("\n\n")}`;
  }

  return {
    cleanedPrompt: prompt,
    contextAppendix,
    images,
    fileBlocks,
  };
};
