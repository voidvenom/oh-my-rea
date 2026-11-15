import { deflateSync } from "node:zlib";
import type { ChatImageBlock, ChatMessage } from "./model.js";

/**
 * Exact 97-glyph X.org 8x13 bitmap font table (printable ASCII 0x20..0x7E,
 * index 95 = `¶` U+00B6, index 96 = `█` U+2588), 13 bytes per glyph (MSB = leftmost pixel).
 */
const FONT_8X13_B64 =
  "AAAAAAAAAAAAAAAAAAAAEBAQEBAQEAAQAAAAACQkJAAAAAAAAAAAAAAAJCR+JH4kJAAAAAAAEDxQUDgUFHgQAAAAACJSJAgIECQqRAAAAAAAADBISDBKRDoAAAAAEBAQAAAAAAAAAAAAAAQICBAQEAgIBAAAAAAgEBAICAgQECAAAAAAJBh+GCQAAAAAAAAAAAAAEBB8EBAAAAAAAAAAAAAAAAAAODBAAAAAAAAAAHwAAAAAAAAAAAAAAAAAAAAQOBAAAAACAgQIECBAgIAAAAAAGCRCSlJiQiQYAAAAABAwUBAQEBAQfAAAAAA8QkICBBggQH4AAAAAfgIECBwCAkI8AAAAAAQMFCRERH4EBAAAAAB+QEBcYgICQjwAAAAAHCBAQFxiQkI8AAAAAH4CBAgIEBAgIAAAAAA8QkJCPEJCQjwAAAAAPEJCRjoCAgQ4AAAAAAAAEDgQAAAQOBAAAAAAABA4EAAAODBAAAAAAgQIECAQCAQCAAAAAAAAAH4AAH4AAAAAAABAIBAIBAgQIEAAAAAAPEJCAgQICAAIAAAAADxCQk5SVkpAPAAAAAAYJEJCQn5CQkIAAAAAeERCRHhEQkR4AAAAADxCQEBAQEBCPAAAAAB4REJCQkJCRHgAAAAAfkBAQHhAQEB+AAAAAH5AQEB4QEBAQAAAAAA8QkBAQE5CRjoAAAAAQkJCQn5CQkJCAAAAAHwQEBAQEBAQfAAAAAAfBAQEBAQERDgAAAAAQkRIUGBQSERCAAAAAEBAQEBAQEBAfgAAAACCgsaqkpKCgoIAAAAAQkJiUkpGQkJCAAAAADxCQkJCQkJCPAAAAAB8QkJCfEBAQEAAAAAAPEJCQkJCUko8AgAAAHxCQkJ8UEhEQgAAAAA8QkBAPAICQjwAAAAA/hAQEBAQEBAQAAAAAEJCQkJCQkJCPAAAAACCgkRERCgoKBAAAAAAgoKCgpKSkqpEAAAAAIKCRCgQKESCggAAAACCgkQoEBAQEBAAAAAAfgIECBAgQEB+AAAAADwgICAgICAgPAAAAACAgEAgEAgEAgIAAAAAeAgICAgICAh4AAAAABAoRAAAAAAAAAAAAAAAAAAAAAAAAAD+AAAQCAAAAAAAAAAAAAAAAAAAADwCPkJGOgAAAABAQEBcYkJCYlwAAAAAAAAAPEJAQEI8AAAAAAICAjpGQkJGOgAAAAAAAAA8Qn5AQjwAAAAAHCIgIHwgICAgAAAAAAAAADpERDhAPEI8AABAQEBcYkJCQkIAAAAAABAAMBAQEBB8AAAAAAAEAAwEBAQEREQ4AABAQEBESHBIREIAAAAAMBAQEBAQEBB8AAAAAAAAAOySkpKSggAAAAAAAABcYkJCQkIAAAAAAAAAPEJCQkI8AAAAAAAAAFxiQmJcQEBAAAAAAAA6RkJGOgICAgAAAAAAXCIgICAgAAAAAAAAADxCMAxCPAAAAAAAICB8ICAgIhwAAAAAAAAAREREREQ6AAAAAAAAAERERCgoEAAAAAAAAACCgpKSqkQAAAAAAAAAQiQYGCRCAAAAAAAAAEJCQkY6AkI8AAAAAAB+BAgQIH4AAAAADhAQCDAIEBAOAAAAABAQEBAQEBAQEAAAAABwCAgQDBAICHAAAAAAJFRIAAAAAAAAAAAAAD50dHQ0FBQUFAAA/////////////////w==";

const FONT_8X13 = Buffer.from(FONT_8X13_B64, "base64");
const GLYPH_HEIGHT = 13;
const PARA_INDEX = 95;
const BLOCK_INDEX = 96;
const NEWLINE_GLYPH = "█";

export interface SnapcompactShape {
  readonly name: "11on16-bw" | "8on22-bw-2048" | "8on22-bw";
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly frameSize: number;
  readonly frameTokenEstimate: number;
  readonly detail?: ChatImageBlock["detail"];
}

export const SNAPCOMPACT_SHAPES: Readonly<
  Record<SnapcompactShape["name"], SnapcompactShape>
> = Object.freeze({
  "11on16-bw": {
    name: "11on16-bw",
    cellWidth: 11,
    cellHeight: 16,
    frameSize: 1568,
    frameTokenEstimate: 1568,
  },
  "8on22-bw-2048": {
    name: "8on22-bw-2048",
    cellWidth: 8,
    cellHeight: 22,
    frameSize: 2048,
    frameTokenEstimate: 1120,
  },
  "8on22-bw": {
    name: "8on22-bw",
    cellWidth: 8,
    cellHeight: 22,
    frameSize: 1568,
    frameTokenEstimate: 1360,
    detail: "high",
  },
});

export const MAX_SNAPCOMPACT_FRAMES = 6;
const TEXT_EDGE_CHARS = 3_200;
const EVIDENCE_RE = /\bev_[0-9a-f]{64}\b/g;
const UNKNOWN_RE = /\bunk_[A-Za-z0-9_-]{6,64}\b/g;

/** Select the eval-tuned omp snapcompact frame geometry for the reader model. */
export const resolveSnapcompactShape = (
  providerId?: string | null,
  modelId?: string | null,
): SnapcompactShape => {
  const hay = `${providerId ?? ""} ${modelId ?? ""}`.toLowerCase();
  if (hay.includes("claude") || hay.includes("anthropic")) {
    return SNAPCOMPACT_SHAPES["11on16-bw"];
  }
  if (
    hay.includes("gemini") ||
    hay.includes("google") ||
    hay.includes("vertex")
  ) {
    return SNAPCOMPACT_SHAPES["8on22-bw-2048"];
  }
  return SNAPCOMPACT_SHAPES["8on22-bw"];
};

export const snapcompactGeometry = (
  shape: SnapcompactShape,
): { cols: number; rows: number; capacity: number } => {
  const cols = Math.floor(shape.frameSize / shape.cellWidth);
  const rows = Math.floor(shape.frameSize / shape.cellHeight);
  return { cols, rows, capacity: cols * rows };
};

const CHAR_FOLDS: Readonly<Record<string, string>> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
  "\u2026": "...",
  "\u2022": "*",
  "\u25b8": ">",
  "\u2192": "->",
  "\u27e6": "[",
  "\u27e7": "]",
};

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Normalize text for the 8x13 bitmap grid: fold newlines into solid block glyphs (`█`),
 * collapse whitespace runs, and map typographic punctuation to crisp ASCII glyphs.
 */
export const normalizeSnapcompactText = (raw: string): string => {
  const stripped = raw.replace(ANSI_RE, "");
  let out = "";
  for (const ch of stripped) {
    if (ch === "\r") continue;
    if (ch === "\n") {
      if (!out.endsWith(NEWLINE_GLYPH)) out += NEWLINE_GLYPH;
      continue;
    }
    if (ch === "\t" || ch === " ") {
      if (out.length > 0 && !out.endsWith(" ") && !out.endsWith(NEWLINE_GLYPH))
        out += " ";
      continue;
    }
    if (ch === "¶" || ch === NEWLINE_GLYPH) {
      out += ch;
      continue;
    }
    const folded = CHAR_FOLDS[ch];
    if (folded !== undefined) {
      out += folded;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else {
      const ascii = ch.normalize("NFKD").replace(/[^\x20-\x7e]/g, "");
      out += ascii || "?";
    }
  }
  return out.trim();
};

const glyphIndex = (ch: string): number => {
  if (ch === "¶") return PARA_INDEX;
  if (ch === NEWLINE_GLYPH) return BLOCK_INDEX;
  const code = ch.charCodeAt(0);
  if (code >= 0x20 && code <= 0x7e) return code - 0x20;
  return "?".charCodeAt(0) - 0x20;
};

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
// 1-bit indexed palette: index 0 = white (#ffffff), index 1 = black ink (#000000).
const PLTE_BW = Buffer.from([0xff, 0xff, 0xff, 0x00, 0x00, 0x00]);
const IEND_CHUNK = pngChunk("IEND", Buffer.alloc(0));

export interface RenderedSnapcompactFrame {
  readonly data: string;
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly rows: number;
  readonly chars: number;
  readonly detail?: ChatImageBlock["detail"];
}

/**
 * Render one page of normalized text into a 1-bit indexed PNG bitmap frame
 * using the embedded X.org 8x13 pixel font (pure Node.js `zlib`, zero LLM/native calls).
 */
export const renderSnapcompactPngFrame = (
  normalizedPage: string,
  shape: SnapcompactShape,
): RenderedSnapcompactFrame => {
  const { cols, rows: maxRows, capacity } = snapcompactGeometry(shape);
  const chars = Math.min(normalizedPage.length, capacity);
  const usedRows = Math.max(
    1,
    Math.min(maxRows, Math.ceil(Math.max(1, chars) / cols)),
  );
  const width = shape.frameSize;
  const height = Math.max(64, usedRows * shape.cellHeight);

  const rowBytes = Math.ceil(width / 8);
  const stride = 1 + rowBytes; // 1 PNG filter byte (0 = None) + packed 1-bit pixels
  const rawScanlines = Buffer.alloc(height * stride, 0);

  for (let row = 0; row < usedRows; row += 1) {
    const lineStart = row * cols;
    if (lineStart >= chars) break;
    const lineEnd = Math.min(chars, lineStart + cols);
    const yBase = row * shape.cellHeight;

    for (let col = 0; col < lineEnd - lineStart; col += 1) {
      const ch = normalizedPage[lineStart + col]!;
      const gIdx = glyphIndex(ch);
      const gOffset = gIdx * GLYPH_HEIGHT;
      const xBase = col * shape.cellWidth;

      for (let gy = 0; gy < GLYPH_HEIGHT; gy += 1) {
        const glyphRowByte = FONT_8X13[gOffset + gy]!;
        if (glyphRowByte === 0) continue;
        const py = yBase + gy;
        if (py >= height) break;
        const scanlineOffset = py * stride + 1;

        if (shape.cellWidth === 8 && (xBase & 7) === 0) {
          // Fast path for 8px cell advance: 1 glyph row = 1 scanline byte.
          rawScanlines[scanlineOffset + (xBase >> 3)] = glyphRowByte;
        } else {
          for (let gx = 0; gx < 8; gx += 1) {
            if ((glyphRowByte & (1 << (7 - gx))) === 0) continue;
            const px = xBase + gx;
            if (px >= width) break;
            rawScanlines[scanlineOffset + (px >> 3)]! |= 1 << (7 - (px & 7));
          }
        }
      }
    }
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth: 1-bit
  ihdr[9] = 3; // color type: 3 (indexed palette)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = deflateSync(rawScanlines, { level: 6 });
  const png = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("PLTE", PLTE_BW),
    pngChunk("IDAT", idat),
    IEND_CHUNK,
  ]);

  return {
    data: png.toString("base64"),
    mimeType: "image/png",
    width,
    height,
    cols,
    rows: usedRows,
    chars,
    ...(shape.detail ? { detail: shape.detail } : {}),
  };
};

const clipMiddle = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const head = Math.round(maxChars * 0.6);
  const tail = maxChars - head;
  return `${text.slice(0, head)} [...${text.length - maxChars}ch elided...] ${text.slice(-tail)}`;
};

/**
 * Serialize messages into omp's compact scope-tagged transcript (`¶user:`, `¶ai:`, `¶call:`)
 * while collecting every full `ev_<64-hex>` and `unk_...` ID for the plain-text ledger index.
 */
export const serializeForSnapcompact = (
  messages: readonly ChatMessage[],
): { serialized: string; evidenceIds: string[]; unknownIds: string[] } => {
  const evSet = new Set<string>();
  const unkSet = new Set<string>();
  const collectIds = (text: string): void => {
    for (const m of text.matchAll(EVIDENCE_RE)) evSet.add(m[0]);
    for (const m of text.matchAll(UNKNOWN_RE)) unkSet.add(m[0]);
  };

  const resultByCallId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.content) collectIds(msg.content);
    for (const tc of msg.tool_calls ?? []) collectIds(tc.function.arguments);
    if (msg.role === "tool" && msg.tool_call_id && msg.content) {
      resultByCallId.set(msg.tool_call_id, msg.content);
    }
  }

  const mergedCallIds = new Set<string>();
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      const content = (msg.content ?? "").trim();
      if (content) parts.push(`¶user:${content}`);
      continue;
    }
    if (msg.role === "assistant") {
      if (msg.content?.trim()) parts.push(`¶ai:${msg.content.trim()}`);
      for (const tc of msg.tool_calls ?? []) {
        const args = clipMiddle(tc.function.arguments || "{}", 500);
        const out = resultByCallId.get(tc.id);
        if (out !== undefined) {
          mergedCallIds.add(tc.id);
          parts.push(
            `¶call:${tc.function.name}(${args})\n<out>\n${clipMiddle(out, 1800)}\n</out>`,
          );
        } else {
          parts.push(`¶call:${tc.function.name}(${args})`);
        }
      }
      continue;
    }
    if (
      msg.role === "tool" &&
      msg.tool_call_id &&
      !mergedCallIds.has(msg.tool_call_id)
    ) {
      parts.push(
        `¶call:\n<out>\n${clipMiddle(msg.content ?? "", 1800)}\n</out>`,
      );
    }
  }

  return {
    serialized: parts.join("\n\n"),
    evidenceIds: [...evSet],
    unknownIds: [...unkSet],
  };
};

export interface SnapcompactArchiveResult {
  readonly summaryText: string;
  readonly images: readonly ChatImageBlock[];
  readonly imageTokens: number;
  readonly frameCount: number;
  readonly totalChars: number;
  readonly shape: SnapcompactShape;
}

/**
 * Build a complete RE-safe snapcompact archive from discarded messages:
 * - Renders the middle history onto dense 8x13 bitmap PNG frames (zero LLM call)
 * - Keeps verbatim plain-text edges (`textHead` / `textTail`)
 * - Pins a plain-text `RETAINED EVIDENCE & UNKNOWN LEDGER` block so 64-hex `ev_...`
 *   and `unk_...` IDs are never subject to visual OCR errors.
 */
export const buildSnapcompactArchive = (
  messages: readonly ChatMessage[],
  options: {
    readonly providerId?: string | null;
    readonly modelId?: string | null;
    readonly previousSummary?: string | null;
    readonly maxFrames?: number;
  } = {},
): SnapcompactArchiveResult => {
  const shape = resolveSnapcompactShape(options.providerId, options.modelId);
  const geo = snapcompactGeometry(shape);
  const maxFrames = Math.max(
    1,
    Math.min(
      options.maxFrames ?? MAX_SNAPCOMPACT_FRAMES,
      MAX_SNAPCOMPACT_FRAMES,
    ),
  );

  const { serialized, evidenceIds, unknownIds } =
    serializeForSnapcompact(messages);
  if (options.previousSummary) {
    for (const m of options.previousSummary.matchAll(EVIDENCE_RE)) {
      if (!evidenceIds.includes(m[0])) evidenceIds.push(m[0]);
    }
    for (const m of options.previousSummary.matchAll(UNKNOWN_RE)) {
      if (!unknownIds.includes(m[0])) unknownIds.push(m[0]);
    }
  }

  const combinedRaw = options.previousSummary
    ? `[Summary of earlier history] ${options.previousSummary}\n\n[Recent conversation]\n${serialized}`
    : serialized;
  const normalized = normalizeSnapcompactText(combinedRaw);

  // Always render at least 1 bitmap frame when history is non-empty so snapcompact produces visual frames,
  // while keeping up to TEXT_EDGE_CHARS at the oldest and newest edges when the transcript is longer.
  let textHead = "";
  let textTail = "";
  let middleNormalized = normalized;
  if (normalized.length > geo.capacity + TEXT_EDGE_CHARS * 2) {
    textHead = normalized.slice(0, TEXT_EDGE_CHARS);
    textTail = normalized.slice(normalized.length - TEXT_EDGE_CHARS);
    middleNormalized = normalized.slice(
      TEXT_EDGE_CHARS,
      normalized.length - TEXT_EDGE_CHARS,
    );
  }

  const maxMiddleChars = geo.capacity * maxFrames;
  let truncatedChars = 0;
  if (middleNormalized.length > maxMiddleChars) {
    truncatedChars = middleNormalized.length - maxMiddleChars;
    middleNormalized = middleNormalized.slice(
      middleNormalized.length - maxMiddleChars,
    );
  }

  const frames: RenderedSnapcompactFrame[] = [];
  for (
    let offset = 0;
    offset < middleNormalized.length;
    offset += geo.capacity
  ) {
    const page = middleNormalized.slice(offset, offset + geo.capacity);
    if (!page) continue;
    frames.push(renderSnapcompactPngFrame(page, shape));
  }

  const images: ChatImageBlock[] = frames.map((f) => ({
    mimeType: f.mimeType,
    data: f.data,
    ...(f.detail ? { detail: f.detail } : {}),
  }));

  const headerLines: string[] = [
    "Resume prior conversation. Earlier turns are archived under HISTORY below (oldest→newest) using snapcompact bitmap frames.",
    "Archived transcript scopes: `¶user:`, `¶ai:`, `¶call:name(args)` and `<out>…</out>` tool output.",
  ];
  if (frames.length > 0) {
    headerLines.push(
      `Reading HISTORY: ${frames.length} attached PNG bitmap image frame${frames.length === 1 ? "" : "s"} (${shape.name}, ${geo.cols} cols × up to ${geo.rows} rows, solid black cell █ = newline). Read left→right, top→bottom.`,
    );
  }
  if (truncatedChars > 0) {
    headerLines.push(
      `Note: ${truncatedChars} older characters were dropped to fit the ${maxFrames}-frame archive budget.`,
    );
  }

  if (evidenceIds.length > 0 || unknownIds.length > 0) {
    headerLines.push(
      "",
      "RETAINED EVIDENCE & UNKNOWN LEDGER (exact plain-text IDs — cite verbatim, do not OCR from pixels):",
    );
    if (evidenceIds.length > 0) {
      headerLines.push(`evidence_ids: ${evidenceIds.slice(0, 64).join(", ")}`);
    }
    if (unknownIds.length > 0) {
      headerLines.push(`unknown_ids: ${unknownIds.slice(0, 32).join(", ")}`);
    }
  }

  headerLines.push("", "HISTORY", "===================");
  if (textHead) {
    headerLines.push(textHead.replaceAll(NEWLINE_GLYPH, "\n"));
    if (frames.length > 0)
      headerLines.push(
        "-------------- imaged bitmap frames attached to this message --------------",
      );
  } else if (frames.length > 0) {
    headerLines.push(
      `-------------- ${frames.length} snapcompact bitmap frame(s) attached to this message --------------`,
    );
  }
  if (textTail) {
    headerLines.push(textTail.replaceAll(NEWLINE_GLYPH, "\n"));
  }

  return {
    summaryText: headerLines.join("\n"),
    images,
    imageTokens: frames.length * shape.frameTokenEstimate,
    frameCount: frames.length,
    totalChars: normalized.length - truncatedChars,
    shape,
  };
};
