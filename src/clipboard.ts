import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { ChatImageBlock } from "./model.js";
import { localFilePath } from "./platform.js";
import { windowsClipboardWrite } from "./platformDesktop.js";

export interface ClipboardImageAttachment {
  readonly id: number;
  readonly mimeType: string;
  /** Base64-encoded image bytes (without `data:` prefix). */
  readonly data: string;
  readonly byteLength: number;
  readonly width: number | null;
  readonly height: number | null;
  /** Saved path in session directory or original source path on disk. */
  readonly filePath: string | null;
  readonly label: string;
}

export interface RawClipboardImage {
  readonly mimeType: string;
  readonly bytes: Buffer;
  readonly sourcePath?: string | null;
}

interface PiNativesClipboardAddon {
  readImageFromClipboard?: () =>
    | Promise<{ data: Uint8Array; mimeType: string } | null>
    | { data: Uint8Array; mimeType: string }
    | null;
  readTextFromClipboard?: () => Promise<string | null> | string | null;
  copyToClipboard?: (text: string) => Promise<void> | void;
}

const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
] as const;

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MiB safety ceiling

/**
 * KDE Plasma Klipper represents an image on the text clipboard channel as `▨ <width> × <height>`.
 * Detecting this placeholder prevents pasting `"▨ 1920 × 168"` as text when the user actually
 * copied an image or triggered terminal bracketed paste on an image.
 */
export const isKlipperImagePlaceholder = (text: string): boolean =>
  /^▨\s*\d+\s*[×x]\s*\d+\s*$/i.test(text.trim());

const parseKlipperImageDimensions = (
  text: string,
): { width: number; height: number } | null => {
  const m = /^▨\s*(\d+)\s*[×x]\s*(\d+)\s*$/i.exec(text.trim());
  if (!m) return null;
  const width = Number.parseInt(m[1]!, 10);
  const height = Number.parseInt(m[2]!, 10);
  return width > 0 && height > 0 ? { width, height } : null;
};

let cachedPiNativesAddon: PiNativesClipboardAddon | null | undefined;

/**
 * Discover and load the native Rust N-API clipboard addon (`@oh-my-pi/pi-natives`) if present
 * in local/global node_modules or Bun's global/cache directories. Provides zero-dependency
 * Wayland (`ext-data-control-v1` / `wlr-data-control-v1`), X11 (`arboard`), macOS, and Windows
 * clipboard image/text access without requiring `wl-paste` or `xclip` binaries.
 */
const loadPiNativesAddon = (): PiNativesClipboardAddon | null => {
  if (process.env["OMR_DISABLE_PI_NATIVES"] === "1") return null;
  if (cachedPiNativesAddon !== undefined) return cachedPiNativesAddon;

  const platform = process.platform;
  const arch = process.arch;
  const pkgShort = `pi-natives-${platform}-${arch}`;
  const pkgScoped = `@oh-my-pi/${pkgShort}`;
  const binaryFilenames = [
    `pi_natives.${platform}-${arch}-modern.node`,
    `pi_natives.${platform}-${arch}-baseline.node`,
    `pi_natives.${platform}-${arch}.node`,
  ];

  const req = createRequire(import.meta.url);
  const candidateDirs: string[] = [];
  const home = homedir();

  // 1. Direct module resolution if installed in node_modules
  for (const name of binaryFilenames) {
    try {
      const resolved = req.resolve(`${pkgScoped}/${name}`);
      const loaded = req(resolved) as PiNativesClipboardAddon;
      if (loaded && typeof loaded === "object") {
        cachedPiNativesAddon = loaded;
        return loaded;
      }
    } catch {
      // Continue searching known global/cache directories
    }
  }

  // 2. Bun global install & cache directories + standard global node_modules
  candidateDirs.push(
    join(home, ".bun", "install", "global", "node_modules", "@oh-my-pi", pkgShort),
    join(home, ".nvm", "versions", "node", process.version, "lib", "node_modules", "@oh-my-pi", pkgShort),
    join("/usr", "local", "lib", "node_modules", "@oh-my-pi", pkgShort),
    join("/usr", "lib", "node_modules", "@oh-my-pi", pkgShort),
  );

  const bunCacheRoot = join(home, ".bun", "install", "cache", "@oh-my-pi");
  try {
    if (existsSync(bunCacheRoot)) {
      const matching = readdirSync(bunCacheRoot)
        .filter((entry) => entry.startsWith(`${pkgShort}@`))
        .sort()
        .reverse();
      for (const entry of matching) {
        candidateDirs.push(join(bunCacheRoot, entry));
      }
    }
  } catch {
    // Ignore permission/read errors
  }

  for (const dir of candidateDirs) {
    for (const filename of binaryFilenames) {
      const fullPath = join(dir, filename);
      try {
        if (!existsSync(fullPath)) continue;
        const loaded = req(fullPath) as PiNativesClipboardAddon;
        if (loaded && typeof loaded === "object") {
          cachedPiNativesAddon = loaded;
          return loaded;
        }
      } catch {
        // Try next binary variant
      }
    }
  }

  cachedPiNativesAddon = null;
  return null;
};

const execCaptureBuffer = (
  cmd: string,
  args: readonly string[],
  options?: { input?: Buffer | string; timeoutMs?: number },
): Promise<Buffer | null> =>
  new Promise((resolvePromise) => {
    const child = execFile(
      cmd,
      [...args],
      {
        encoding: "buffer",
        timeout: options?.timeoutMs ?? 2_500,
        maxBuffer: MAX_IMAGE_BYTES,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err || !Buffer.isBuffer(stdout)) {
          resolvePromise(null);
          return;
        }
        resolvePromise(stdout);
      },
    );
    if (options?.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    } else if (child.stdin) {
      child.stdin.end();
    }
  });

const execFireAndForget = (
  cmd: string,
  args: readonly string[],
  input: string,
  timeoutMs = 2_000,
): Promise<boolean> =>
  new Promise((resolvePromise) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolvePromise(ok);
    };
    try {
      const child = execFile(
        cmd,
        [...args],
        { timeout: timeoutMs, windowsHide: true },
        (err) => finish(!err),
      );
      child.on("error", () => finish(false));
      if (child.stdin) {
        child.stdin.on("error", () => finish(false));
        child.stdin.end(Buffer.from(input, "utf8"));
      }
      // xclip stays alive in background holding X11 selection; resolve once stdin closes
      setTimeout(() => finish(true), 120).unref?.();
    } catch {
      finish(false);
    }
  });

/** Sniff image dimensions (width x height) from PNG, GIF, WebP, BMP, or JPEG header bytes. */
export const sniffImageDimensions = (
  bytes: Buffer,
): { width: number; height: number } | null => {
  if (bytes.length < 10) return null;
  // GIF87a / GIF89a (10 bytes minimum)
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const width = bytes.readUInt16LE(6);
    const height = bytes.readUInt16LE(8);
    if (width > 0 && height > 0) return { width, height };
  }
  if (bytes.length < 24) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR at offset 16..24
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height };
  }
  // BMP: 42 4D + DIB header width/height at offset 18..26
  if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length >= 26) {
    const width = Math.abs(bytes.readInt32LE(18));
    const height = Math.abs(bytes.readInt32LE(22));
    if (width > 0 && height > 0) return { width, height };
  }
  // RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunk = bytes.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X" && bytes.length >= 30) {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      return { width, height };
    }
    if (chunk === "VP8 " && bytes.length >= 30) {
      const width = bytes.readUInt16LE(26) & 0x3fff;
      const height = bytes.readUInt16LE(28) & 0x3fff;
      if (width > 0 && height > 0) return { width, height };
    }
    if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      if (width > 0 && height > 0) return { width, height };
    }
  }
  // JPEG: scan SOF0..SOF3 markers
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      if (
        marker >= 0xc0 &&
        marker <= 0xc3 &&
        offset + 8 < bytes.length
      ) {
        const height = bytes.readUInt16BE(offset + 5);
        const width = bytes.readUInt16BE(offset + 7);
        if (width > 0 && height > 0) return { width, height };
        break;
      }
      if (marker === 0xd9 || marker === 0xda) break;
      const segLen = bytes.readUInt16BE(offset + 2);
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
  }
  return null;
};

/** Sniff MIME type from magic bytes when extension is unknown. */
export const sniffImageMimeType = (bytes: Buffer): string | null => {
  if (bytes.length < 10) return null;
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (bytes.length < 12) return null;
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length >= 26) {
    return "image/bmp";
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
};

/**
 * Check if a text string (from clipboard or drag-and-drop paste) is a path or `file://` URL
 * to a local image file on disk, and load it if so.
 */
export const tryLoadImageFromPathText = (
  rawText: string,
  cwd: string = process.cwd(),
): RawClipboardImage | null => {
  const trimmed = rawText.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed || trimmed.includes("\n")) return null;
  let candidate: string;
  try { candidate = localFilePath(trimmed); } catch { return null; }
  const ext = extname(candidate).toLowerCase();
  const expectedMime = IMAGE_EXTENSIONS[ext];
  if (!expectedMime) return null;

  const resolved = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
  try {
    if (!existsSync(resolved)) return null;
    const st = statSync(resolved);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_IMAGE_BYTES) return null;
    const bytes = readFileSync(resolved);
    const mimeType = sniffImageMimeType(bytes) ?? expectedMime;
    return { mimeType, bytes, sourcePath: resolved };
  } catch {
    return null;
  }
};

const queryKdeKlipperDbusContents = async (): Promise<string | null> => {
  for (const bin of ["qdbus6", "qdbus"]) {
    const out = await execCaptureBuffer(
      bin,
      [
        "org.kde.klipper",
        "/klipper",
        "org.kde.klipper.klipper.getClipboardContents",
      ],
      { timeoutMs: 1_200 },
    );
    if (out !== null) {
      return out.toString("utf8").replace(/\r?\n$/, "");
    }
  }
  return null;
};

const listKdeKlipperEntries = (
  customDataDir?: string,
): ReadonlyArray<{ name: string; dirPath: string; mtimeMs: number }> => {
  const dataDir =
    customDataDir ??
    process.env["OMR_KLIPPER_DATA_DIR"] ??
    join(homedir(), ".local", "share", "klipper", "data");
  try {
    if (!existsSync(dataDir)) return [];
    const dirs: Array<{ name: string; dirPath: string; mtimeMs: number }> = [];
    for (const name of readdirSync(dataDir)) {
      const dirPath = join(dataDir, name);
      try {
        const st = statSync(dirPath);
        if (st.isDirectory()) {
          dirs.push({ name, dirPath, mtimeMs: st.mtimeMs });
        }
      } catch {
        // Ignore transient Klipper entry removal
      }
    }
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return dirs;
  } catch {
    return [];
  }
};

const readImageFromKlipperEntryDir = (
  entry: { name: string; dirPath: string },
): RawClipboardImage | null => {
  try {
    const files = readdirSync(entry.dirPath);
    // Prioritize the payload file whose name matches the directory hash
    const ordered = [
      ...files.filter((f) => f === entry.name),
      ...files.filter((f) => f !== entry.name),
    ];
    for (const file of ordered) {
      const fullPath = join(entry.dirPath, file);
      try {
        const st = statSync(fullPath);
        if (!st.isFile() || st.size < 10 || st.size > MAX_IMAGE_BYTES) continue;
        const bytes = readFileSync(fullPath);
        const mimeType = sniffImageMimeType(bytes);
        if (mimeType) {
          return { mimeType, bytes };
        }
      } catch {
        // Ignore unreadable file
      }
    }
  } catch {
    // Ignore unreadable directory
  }
  return null;
};

/**
 * Read the active clipboard image from KDE Plasma 6 Klipper (`~/.local/share/klipper/data/<uuid>`
 * and `qdbus6 org.kde.klipper /klipper`) when `wl-paste` / `xclip` are not installed.
 */
export const readKdeKlipperClipboardImage = async (
  customDataDir?: string,
): Promise<RawClipboardImage | null> => {
  const entries = listKdeKlipperEntries(customDataDir);
  if (entries.length === 0) return null;

  // 1. Check the newest Klipper entry directory first (updated whenever an image/screenshot is copied)
  const newestImg = readImageFromKlipperEntryDir(entries[0]!);
  if (newestImg) return newestImg;

  // 2. If the user re-selected an earlier image in Klipper history, qdbus6 reports `▨ <W> × <H>`
  if (!customDataDir && !process.env["OMR_KLIPPER_DATA_DIR"]) {
    const dbusText = await queryKdeKlipperDbusContents();
    if (dbusText && isKlipperImagePlaceholder(dbusText)) {
      const targetDims = parseKlipperImageDimensions(dbusText);
      for (const entry of entries.slice(0, 8)) {
        const candidate = readImageFromKlipperEntryDir(entry);
        if (!candidate) continue;
        if (!targetDims) return candidate;
        const dims = sniffImageDimensions(candidate.bytes);
        if (
          dims &&
          dims.width === targetDims.width &&
          dims.height === targetDims.height
        ) {
          return candidate;
        }
      }
    }
  }

  return null;
};

/**
 * Read the active plain-text clipboard item from KDE Plasma 6 Klipper.
 */
export const readKdeKlipperClipboardText = async (
  customDataDir?: string,
): Promise<string> => {
  const entries = listKdeKlipperEntries(customDataDir);
  if (entries.length > 0) {
    const newest = entries[0]!;
    // If the newest Klipper directory holds an image, the active clipboard item is an image, not text
    if (readImageFromKlipperEntryDir(newest)) {
      return "";
    }
    const primaryPayload = join(newest.dirPath, newest.name);
    try {
      if (existsSync(primaryPayload)) {
        const st = statSync(primaryPayload);
        if (st.isFile() && st.size > 0 && st.size <= MAX_IMAGE_BYTES) {
          const buf = readFileSync(primaryPayload);
          if (!sniffImageMimeType(buf)) {
            const text = buf.toString("utf8").replace(/\r\n/g, "\n");
            if (!isKlipperImagePlaceholder(text)) return text;
          }
        }
      }
    } catch {
      // Fall through to DBus query
    }
  }

  if (!customDataDir && !process.env["OMR_KLIPPER_DATA_DIR"]) {
    const dbusText = await queryKdeKlipperDbusContents();
    if (dbusText && !isKlipperImagePlaceholder(dbusText)) {
      return dbusText.replace(/\r\n/g, "\n");
    }
  }
  return "";
};

/**
 * Read an image from the system clipboard (`@oh-my-pi/pi-natives` Wayland/X11/macOS/Windows addon,
 * Wayland `wl-paste`, X11 `xclip`, KDE Plasma Klipper store, macOS `pngpaste`/`osascript`,
 * Windows/WSL PowerShell), or from a copied image file path on disk.
 */
export const readImageFromClipboard = async (
  cwd: string = process.cwd(),
): Promise<RawClipboardImage | null> => {
  // 0. Explicit Klipper directory override (used for deterministic testing or custom KDE setups)
  if (process.env["OMR_KLIPPER_DATA_DIR"]) {
    const klipperOverride = await readKdeKlipperClipboardImage(
      process.env["OMR_KLIPPER_DATA_DIR"],
    );
    if (klipperOverride) return klipperOverride;
  }

  // 1. In-process native clipboard addon (`@oh-my-pi/pi-natives` -> `wl-clipboard-rs` / `arboard`)
  const nativeAddon = loadPiNativesAddon();
  if (nativeAddon?.readImageFromClipboard) {
    try {
      const nativeImg = await nativeAddon.readImageFromClipboard();
      if (nativeImg && nativeImg.data && nativeImg.data.byteLength > 0) {
        const bytes = Buffer.from(
          nativeImg.data.buffer,
          nativeImg.data.byteOffset,
          nativeImg.data.byteLength,
        );
        const mimeType =
          sniffImageMimeType(bytes) ?? nativeImg.mimeType ?? "image/png";
        return { mimeType, bytes };
      }
    } catch {
      // Fall through to CLI / desktop clipboard backends
    }
  }

  // 2. Wayland (`wl-paste`)
  if (process.platform === "linux" && process.env["WAYLAND_DISPLAY"]) {
    const typesBuf = await execCaptureBuffer("wl-paste", ["--list-types"]);
    if (typesBuf) {
      const types = new Set(
        typesBuf
          .toString("utf8")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
      for (const mime of IMAGE_MIME_TYPES) {
        if (!types.has(mime)) continue;
        const imgBuf = await execCaptureBuffer("wl-paste", ["--type", mime]);
        if (imgBuf && imgBuf.length > 0 && sniffImageMimeType(imgBuf)) {
          return { mimeType: mime, bytes: imgBuf };
        }
      }
    }
  }

  // 3. X11 (`xclip`)
  if (process.platform === "linux" && process.env["DISPLAY"]) {
    const targetsBuf = await execCaptureBuffer("xclip", [
      "-selection",
      "clipboard",
      "-t",
      "TARGETS",
      "-o",
    ]);
    if (targetsBuf) {
      const targets = new Set(
        targetsBuf
          .toString("utf8")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
      for (const mime of IMAGE_MIME_TYPES) {
        if (!targets.has(mime)) continue;
        const imgBuf = await execCaptureBuffer("xclip", [
          "-selection",
          "clipboard",
          "-t",
          mime,
          "-o",
        ]);
        if (imgBuf && imgBuf.length > 0 && sniffImageMimeType(imgBuf)) {
          return { mimeType: mime, bytes: imgBuf };
        }
      }
    }
  }

  // 4. Linux KDE Plasma 6 Klipper live clipboard store (`~/.local/share/klipper/data/<uuid>`)
  if (process.platform === "linux") {
    const klipperImg = await readKdeKlipperClipboardImage();
    if (klipperImg) return klipperImg;
  }

  // 5. macOS (`pngpaste` or AppleScript PNG clipboard)
  if (process.platform === "darwin") {
    const pngPaste = await execCaptureBuffer("pngpaste", ["-"]);
    if (pngPaste && pngPaste.length > 0 && sniffImageMimeType(pngPaste)) {
      return { mimeType: "image/png", bytes: pngPaste };
    }
  }

  // 6. Windows or WSL (`powershell.exe`)
  if (process.platform === "win32" || process.env["WSL_DISTRO_NAME"]) {
    const script =
      "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;$i=[System.Windows.Forms.Clipboard]::GetImage();if($i -ne $null){$m=New-Object System.IO.MemoryStream;$i.Save($m,[System.Drawing.Imaging.ImageFormat]::Png);[Console]::Out.Write([Convert]::ToBase64String($m.ToArray()))}";
    const b64Buf = await execCaptureBuffer(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Sta", "-Command", script],
      { timeoutMs: 4_000 },
    );
    if (b64Buf && b64Buf.length > 0) {
      const b64 = b64Buf.toString("utf8").trim();
      if (b64.length > 0) {
        const bytes = Buffer.from(b64, "base64");
        if (bytes.length > 0 && sniffImageMimeType(bytes)) {
          return { mimeType: "image/png", bytes };
        }
      }
    }
  }

  // 7. Fallback: if clipboard holds a file:// URI or path to an image file on disk
  const clipText = await readTextFromClipboard();
  if (clipText) {
    const fromPath = tryLoadImageFromPathText(clipText, cwd);
    if (fromPath) return fromPath;
  }

  return null;
};

/**
 * Read plain UTF-8 text from the system clipboard.
 */
export const readTextFromClipboard = async (): Promise<string> => {
  if (process.env["OMR_KLIPPER_DATA_DIR"]) {
    const klipperText = await readKdeKlipperClipboardText(
      process.env["OMR_KLIPPER_DATA_DIR"],
    );
    if (klipperText) return klipperText;
  }

  const nativeAddon = loadPiNativesAddon();
  if (nativeAddon?.readTextFromClipboard) {
    try {
      const nativeText = await nativeAddon.readTextFromClipboard();
      if (typeof nativeText === "string" && nativeText.length > 0) {
        const normalized = nativeText.replace(/\r\n/g, "\n");
        if (!isKlipperImagePlaceholder(normalized)) {
          return normalized;
        }
      }
    } catch {
      // Fall through to CLI / desktop clipboard backends
    }
  }

  if (process.platform === "darwin") {
    const out = await execCaptureBuffer("pbpaste", []);
    return out ? out.toString("utf8").replace(/\r\n/g, "\n") : "";
  }
  if (process.platform === "linux") {
    if (process.env["WAYLAND_DISPLAY"]) {
      const wl = await execCaptureBuffer("wl-paste", [
        "--type",
        "text",
        "--no-newline",
      ]);
      if (wl) {
        const text = wl.toString("utf8").replace(/\r\n/g, "\n");
        if (!isKlipperImagePlaceholder(text)) return text;
      }
      const wlPlain = await execCaptureBuffer("wl-paste", ["--no-newline"]);
      if (wlPlain) {
        const text = wlPlain.toString("utf8").replace(/\r\n/g, "\n");
        if (!isKlipperImagePlaceholder(text)) return text;
      }
    }
    if (process.env["DISPLAY"]) {
      const xc = await execCaptureBuffer("xclip", [
        "-selection",
        "clipboard",
        "-o",
      ]);
      if (xc) {
        const text = xc.toString("utf8").replace(/\r\n/g, "\n");
        if (!isKlipperImagePlaceholder(text)) return text;
      }
      const xs = await execCaptureBuffer("xsel", ["--clipboard", "--output"]);
      if (xs) {
        const text = xs.toString("utf8").replace(/\r\n/g, "\n");
        if (!isKlipperImagePlaceholder(text)) return text;
      }
    }
    const klipperText = await readKdeKlipperClipboardText();
    if (klipperText) return klipperText;
  }
  if (process.platform === "win32" || process.env["WSL_DISTRO_NAME"]) {
    const out = await execCaptureBuffer("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Console]::Out.Write([string](Get-Clipboard -Raw))",
    ]);
    if (out) return out.toString("utf8").replace(/\r\n/g, "\n");
  }
  return "";
};

/**
 * Copy UTF-8 text to the terminal (OSC 52 clipboard + primary) and local system clipboard
 * (`pi-natives`, `wl-copy`, `xclip`, `xsel`, `qdbus6`, `pbcopy`, or PowerShell).
 */
export const copyTextToClipboard = async (
  text: string,
  writeOsc?: (sequence: string) => void,
): Promise<boolean> => {
  if (!text) return false;
  const b64 = Buffer.from(text, "utf8").toString("base64");
  if (writeOsc) {
    // Write both clipboard ('c') and primary selection ('p') via OSC 52
    writeOsc(`\x1b]52;c;${b64}\x07\x1b]52;p;${b64}\x07`);
  }

  let copiedNatively = false;
  const nativeAddon = loadPiNativesAddon();
  if (nativeAddon?.copyToClipboard) {
    try {
      await nativeAddon.copyToClipboard(text);
      copiedNatively = true;
    } catch {
      // Fall through to CLI clipboard utilities
    }
  }

  if (process.platform === "darwin") {
    const ok = await execFireAndForget("pbcopy", [], text);
    return ok || copiedNatively || Boolean(writeOsc);
  }
  if (process.platform === "linux") {
    let copied = copiedNatively;
    if (process.env["WAYLAND_DISPLAY"]) {
      const okClip = await execFireAndForget("wl-copy", [], text);
      void execFireAndForget("wl-copy", ["--primary"], text);
      if (okClip) copied = true;
    }
    if (process.env["DISPLAY"]) {
      const okXclip = await execFireAndForget(
        "xclip",
        ["-selection", "clipboard"],
        text,
      );
      void execFireAndForget("xclip", ["-selection", "primary"], text);
      if (okXclip) copied = true;
      else {
        const okXsel = await execFireAndForget(
          "xsel",
          ["--clipboard", "--input"],
          text,
        );
        if (okXsel) copied = true;
      }
    }
    if (!copied) {
      const okKlipper = await execCaptureBuffer(
        "qdbus6",
        [
          "org.kde.klipper",
          "/klipper",
          "org.kde.klipper.klipper.setClipboardContents",
          text,
        ],
        { timeoutMs: 1_200 },
      );
      if (okKlipper !== null) copied = true;
    }
    if (!copied && process.env["WSL_DISTRO_NAME"]) {
      const { command, args, input } = windowsClipboardWrite(text);
      copied = (await execCaptureBuffer(command, args, { input })) !== null;
    }
    return copied || Boolean(writeOsc);
  }
  if (process.platform === "win32") {
    const { command, args, input } = windowsClipboardWrite(text);
    const ok = (await execCaptureBuffer(command, args, { input })) !== null;
    return ok || copiedNatively || Boolean(writeOsc);
  }
  return copiedNatively || Boolean(writeOsc);
};

export const toClipboardImageAttachment = (
  id: number,
  input: RawClipboardImage | ClipboardImageAttachment,
  filePathOverride?: string | null,
): ClipboardImageAttachment => {
  if ("data" in input && "byteLength" in input && "label" in input) {
    return input;
  }
  const raw = input;
  const dims = sniffImageDimensions(raw.bytes);
  const ext =
    raw.mimeType === "image/jpeg"
      ? "jpg"
      : raw.mimeType === "image/webp"
        ? "webp"
        : raw.mimeType === "image/gif"
          ? "gif"
          : raw.mimeType === "image/bmp"
            ? "bmp"
            : "png";
  const filePath =
    filePathOverride !== undefined
      ? filePathOverride
      : (raw.sourcePath ?? null);
  const kb = Math.max(1, Math.round(raw.bytes.length / 1024));
  const dimPart = dims ? ` ${dims.width}×${dims.height}` : "";
  const label = `Image #${id} (${ext.toUpperCase()}${dimPart} · ${kb} KB)`;
  return {
    id,
    mimeType: raw.mimeType,
    data: raw.bytes.toString("base64"),
    byteLength: raw.bytes.length,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    filePath,
    label,
  };
};

/**
 * Materialize a raw clipboard image into a `ClipboardImageAttachment` (persisting a copy inside
 * `sessionDir` when provided so REA tools and scripts can also inspect the file on disk).
 */
export const buildClipboardImageAttachment = async (
  id: number,
  raw: RawClipboardImage,
  sessionDir?: string | null,
): Promise<ClipboardImageAttachment> => {
  const ext =
    raw.mimeType === "image/jpeg"
      ? "jpg"
      : raw.mimeType === "image/webp"
        ? "webp"
        : raw.mimeType === "image/gif"
          ? "gif"
          : raw.mimeType === "image/bmp"
            ? "bmp"
            : "png";
  let filePath: string | null = raw.sourcePath ?? null;
  if (!filePath && sessionDir) {
    try {
      const hash = createHash("sha256")
        .update(raw.bytes)
        .digest("hex")
        .slice(0, 10);
      const dir = join(sessionDir, "attachments");
      await mkdir(dir, { recursive: true });
      const target = join(dir, `pasted-image-${hash}.${ext}`);
      await writeFile(target, raw.bytes);
      filePath = target;
    } catch {
      filePath = null;
    }
  }
  return toClipboardImageAttachment(id, raw, filePath);
};

export const toChatImageBlock = (
  att: ClipboardImageAttachment,
): ChatImageBlock => ({
  mimeType: att.mimeType,
  data: att.data,
});
