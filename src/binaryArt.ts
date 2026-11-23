import { open, stat } from "node:fs/promises";
import {
  centerAnsi,
  gradientText,
  padEndAnsi,
  truncateAnsi,
  visibleWidth,
  type ColorTheme,
} from "./ansi.js";
import { VERSION } from "./version.js";
import type { I18n } from "./i18n/index.js";
import { renderSupportLine } from "./support.js";

export interface TargetMagic {
  readonly path: string;
  readonly sizeBytes: number | null;
  readonly label: string;
  readonly bytes: Uint8Array;
}

// Default cyber-forensic signature bytes (ELF64, Mach-O64, APK/ZIP, PE, WASM, "OMR!")
const DEFAULT_STREAM_BYTES = Uint8Array.from([
  0x7f,
  0x45,
  0x4c,
  0x46,
  0x02,
  0x01,
  0x01,
  0x00, // .ELF....
  0xcf,
  0xfa,
  0xed,
  0xfe,
  0x07,
  0x00,
  0x00,
  0x01, // Mach-O 64
  0x50,
  0x4b,
  0x03,
  0x04,
  0x14,
  0x00,
  0x08,
  0x00, // PK.. (APK)
  0x4d,
  0x5a,
  0x90,
  0x00,
  0x03,
  0x00,
  0x00,
  0x00, // MZ.. (PE)
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00, // .asm (WASM)
  0x64,
  0x65,
  0x78,
  0x0a,
  0x30,
  0x33,
  0x39,
  0x00, // dex.039.
  0xca,
  0xfe,
  0xba,
  0xbe,
  0x4f,
  0x4d,
  0x52,
  0x21, // ....OMR!
  0x55,
  0x48,
  0x89,
  0xe5,
  0x48,
  0x83,
  0xec,
  0x20, // push rbp; mov rbp,rsp
]);

const classifyMagic = (bytes: Uint8Array, path: string): string => {
  const lower = path.toLowerCase();
  if (bytes.length >= 4) {
    const b0 = bytes[0]!;
    const b1 = bytes[1]!;
    const b2 = bytes[2]!;
    const b3 = bytes[3]!;
    if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46) {
      const bits =
        bytes[4] === 2 ? "64-bit" : bytes[4] === 1 ? "32-bit" : "ELF";
      const endian = bytes[5] === 1 ? "LSB" : bytes[5] === 2 ? "MSB" : "";
      return `ELF ${bits}${endian ? ` ${endian}` : ""}`;
    }
    if (b0 === 0x50 && b1 === 0x4b && (b2 === 0x03 || b2 === 0x05)) {
      if (lower.endsWith(".apk")) return "Android APK";
      if (lower.endsWith(".aab")) return "Android AAB";
      if (lower.endsWith(".ipa")) return "iOS IPA Bundle";
      if (lower.endsWith(".jar")) return "JVM JAR Archive";
      return "ZIP / Package";
    }
    if (b0 === 0x4d && b1 === 0x5a) {
      return lower.endsWith(".dll") ? "PE/COFF DLL" : "PE/COFF Executable";
    }
    if (
      (b0 === 0xcf && b1 === 0xfa && b2 === 0xed && b3 === 0xfe) ||
      (b0 === 0xfe && b1 === 0xed && b2 === 0xfa && b3 === 0xcf)
    ) {
      return "Mach-O 64-bit";
    }
    if (
      (b0 === 0xce && b1 === 0xfa && b2 === 0xed && b3 === 0xfe) ||
      (b0 === 0xfe && b1 === 0xed && b2 === 0xfa && b3 === 0xce)
    ) {
      return "Mach-O 32-bit";
    }
    if (b0 === 0xca && b1 === 0xfe && b2 === 0xba && b3 === 0xbe) {
      return lower.endsWith(".class") ? "JVM Class" : "Universal Mach-O / Fat";
    }
    if (b0 === 0x64 && b1 === 0x65 && b2 === 0x78 && b3 === 0x0a) {
      return "Dalvik DEX";
    }
    if (b0 === 0x00 && b1 === 0x61 && b2 === 0x73 && b3 === 0x6d) {
      return "WebAssembly";
    }
    if (b0 === 0x53 && b1 === 0x51 && b2 === 0x4c && b3 === 0x69) {
      return "SQLite 3 DB";
    }
    if (
      (b0 === 0xd4 && b1 === 0xc3 && b2 === 0xb2 && b3 === 0xa1) ||
      (b0 === 0xa1 && b1 === 0xb2 && b2 === 0xc3 && b3 === 0xd4)
    ) {
      return "PCAP Capture";
    }
    if (b0 === 0x0a && b1 === 0x0d && b2 === 0x0d && b3 === 0x0a) {
      return "PCAPNG Capture";
    }
    if (b0 === 0xaf && b1 === 0x1b && b2 === 0xb1 && b3 === 0xfa) {
      return "Unity IL2CPP Metadata";
    }
    if (b0 === 0xd0 && b1 === 0x0d && b2 === 0xfe && b3 === 0xed) {
      return "DeviceTree DTB";
    }
    if (b0 === 0x46 && b1 === 0x4f && b2 === 0x52 && b3 === 0x31) {
      return "Erlang BEAM";
    }
    if (
      b0 === 0xe9 &&
      (lower.endsWith(".bin") ||
        lower.endsWith(".img") ||
        lower.endsWith(".fw"))
    ) {
      return "ESP32 Firmware";
    }
    if (b2 === 0x0d && b3 === 0x0a && lower.endsWith(".pyc")) {
      return "Python Bytecode";
    }
  }
  if (lower.endsWith(".asar")) return "Electron ASAR";
  if (lower.endsWith(".dmg")) return "Apple DMG";
  if (lower.endsWith(".ko")) return "Linux Kernel Module";
  if (lower.endsWith(".dtb")) return "DeviceTree DTB";
  if (lower.endsWith(".pyc")) return "Python Bytecode";
  if (lower.endsWith(".beam")) return "Erlang BEAM";
  if (lower.endsWith(".evm")) return "EVM Bytecode";
  if (
    lower.endsWith(".bin") ||
    lower.endsWith(".fw") ||
    lower.endsWith(".img") ||
    lower.endsWith(".rom")
  ) {
    return "Firmware Image";
  }
  return "Binary Artifact";
};

/**
 * Safely read at most the first 64 bytes of a target file (read-only, zero
 * mutation) so the TUI can display its real magic signature and stream its bits.
 */
export const inspectTargetMagic = async (
  path: string | null,
): Promise<TargetMagic | null> => {
  if (!path) return null;
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      return {
        path,
        sizeBytes: null,
        label: path.endsWith(".app") ? "Apple App Bundle" : "Directory Target",
        bytes: DEFAULT_STREAM_BYTES,
      };
    }
    if (!info.isFile()) return null;
    const handle = await open(path, "r");
    try {
      const buf = Buffer.alloc(64);
      const { bytesRead } = await handle.read(buf, 0, 64, 0);
      const slice = Uint8Array.from(buf.subarray(0, bytesRead));
      return {
        path,
        sizeBytes: info.size,
        label: classifyMagic(slice, path),
        bytes: slice.length >= 8 ? slice : DEFAULT_STREAM_BYTES,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

export const formatBytes = (bytes: number | null): string => {
  if (bytes === null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

// Every row is strictly 28 visual columns of 1-cell Unicode box/block glyphs.
const OMR_LOGO_FULL = [
  " ██████╗ ███╗   ███╗██████╗ ",
  "██╔═══██╗████╗ ████║██╔══██╗",
  "██║   ██║██╔████╔██║██████╔╝",
  "██║   ██║██║╚██╔╝██║██╔══██╗",
  "╚██████╔╝██║ ╚═╝ ██║██║  ██║",
  " ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝",
] as const;

const OMR_LOGO_COMPACT = ["╔═╗╔╦╗╦═╗", "║ ║║║║╠╦╝", "╚═╝╩ ╩╩╚═"] as const;

const LOGO_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 245, 160], // Matrix Mint
  [0, 217, 245], // Electric Cyan
  [129, 140, 248], // Cyber Indigo
];

const wingBit = (bytes: Uint8Array, bitIndex: number, lane: number): number => {
  const totalBits = bytes.length * 8;
  const normalized = ((bitIndex % totalBits) + totalBits) % totalBits;
  const byteIdx = Math.floor(normalized / 8);
  let b = bytes[byteIdx] ?? 0;
  // Keep decorative wings lively across zero-padded ELF/PE header regions while
  // seeded deterministically from the target's real bytes.
  if (b === 0x00 || b === 0xff) {
    b ^= (byteIdx * 0x9e + lane * 0x53 + 0x6d) & 0xff;
  }
  const shift = 7 - (normalized % 8);
  return (b >> shift) & 1;
};

/**
 * Render a horizontal phosphor-shaded flowing binary lane of exact `width`
 * columns (`0`/`1` bits with grouped spacing and glowing wave highlights).
 */
export const renderBinaryLane = (
  width: number,
  tick: number,
  lane: number,
  bytes: Uint8Array,
  theme: ColorTheme,
  direction: 1 | -1 = 1,
): string => {
  if (width <= 0) return "";
  const source = bytes.length > 0 ? bytes : DEFAULT_STREAM_BYTES;
  const offset = tick * direction * 2 + lane * 13;
  if (!theme.enabled) {
    let plain = "";
    for (let c = 0; c < width; c += 1) {
      plain += c % 9 === 8 ? " " : String(wingBit(source, c + offset, lane));
    }
    return plain;
  }

  let out = "";
  const wavePeriod = 18;
  for (let c = 0; c < width; c += 1) {
    if (c % 9 === 8) {
      out += " ";
      continue;
    }
    const bit = wingBit(source, c + offset, lane);
    // Moving phosphor wave across the bitstream
    const phase =
      (((c * direction - tick * 2 + lane * 5) % wavePeriod) + wavePeriod) %
      wavePeriod;
    let color: string;
    if (phase === 0 || phase === 1) {
      color =
        bit === 1
          ? `${theme.bold}${theme.neonMint}`
          : `${theme.bold}${theme.neonCyan}`;
    } else if (phase <= 4) {
      color = bit === 1 ? theme.emerald : theme.sky;
    } else if (phase <= 8) {
      color = theme.borderActive;
    } else {
      color = theme.subtle;
    }
    out += `${color}${bit}${theme.reset}`;
  }
  return out;
};

/** Format one 8-byte hex + binary + ASCII disassembler inspection line. */
export const renderHexBitRow = (
  width: number,
  bytes: Uint8Array,
  byteOffset: number,
  tick: number,
  theme: ColorTheme,
): string => {
  const source = bytes.length > 0 ? bytes : DEFAULT_STREAM_BYTES;
  const len = source.length;
  const addr = ((byteOffset % 0x10000) + 0x10000) % 0x10000;
  const addrHex = `0x${addr.toString(16).padStart(4, "0")}`;

  const hexParts: string[] = [];
  const bitParts: string[] = [];
  let ascii = "";
  for (let i = 0; i < 6; i += 1) {
    const b = source[(byteOffset + i) % len] ?? 0;
    const highlight = (i + tick) % 6 === 0;
    const hex = b.toString(16).padStart(2, "0");
    hexParts.push(
      theme.enabled
        ? `${highlight ? `${theme.bold}${theme.neonMint}` : theme.neonCyan}${hex}${theme.reset}`
        : hex,
    );
    if (i < 3) {
      const bits = b.toString(2).padStart(8, "0");
      bitParts.push(
        theme.enabled
          ? `${highlight ? theme.emerald : theme.subtle}${bits}${theme.reset}`
          : bits,
      );
    }
    ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "·";
  }

  const full = theme.enabled
    ? `${theme.indigo}${addrHex}${theme.reset}  ${hexParts.join(" ")}  ${bitParts.join(" ")}  ${theme.muted}│${ascii}│${theme.reset}`
    : `${addrHex}  ${hexParts.join(" ")}  ${bitParts.join(" ")}  |${ascii}|`;

  if (visibleWidth(full) <= width) return full;
  const medium = theme.enabled
    ? `${theme.indigo}${addrHex}${theme.reset}  ${hexParts.join(" ")}  ${theme.muted}│${ascii}│${theme.reset}`
    : `${addrHex}  ${hexParts.join(" ")}  |${ascii}|`;
  return truncateAnsi(medium, width);
};

/** Compact inline flowing binary scanner for active tool calls & header bar. */
export const renderBinaryPulse = (
  tick: number,
  bytes: Uint8Array | null,
  theme: ColorTheme,
  bitCount = 8,
): string => {
  const source = bytes && bytes.length > 0 ? bytes : DEFAULT_STREAM_BYTES;
  let bits = "";
  for (let i = 0; i < bitCount; i += 1) {
    const bit = wingBit(source, tick * 3 + i, 1);
    if (!theme.enabled) {
      bits += String(bit);
    } else {
      const hot = i === tick % bitCount || i === (tick + 1) % bitCount;
      bits += `${hot ? `${theme.bold}${theme.neonMint}` : theme.neonCyan}${bit}${theme.reset}`;
    }
  }
  return theme.enabled
    ? `${theme.subtle}⟪${theme.reset}${bits}${theme.subtle}⟫${theme.reset}`
    : `[${bits}]`;
};

export interface HeroRenderContext {
  readonly i18n: I18n;
  readonly width: number;
  readonly height: number;
  readonly tick: number;
  readonly binaryEnabled: boolean;
  readonly model: string;
  readonly reaConnected: boolean;
  readonly reaTools: number;
  readonly target: string | null;
  readonly magic: TargetMagic | null;
  readonly candidates: readonly string[];
  readonly sessionId: string;
  readonly theme: ColorTheme;
  readonly hyperlinks?: boolean;
}

/**
 * Render the signature OMR Hero Screen with custom block logo, flanking live
 * binary bitstreams, real target magic hex/bit disassembler strip, and
 * quick-launch forensic workflow guide.
 */
export const renderHeroLines = (ctx: HeroRenderContext): string[] => {
  const { width, height, tick, binaryEnabled, theme } = ctx;
  const { t } = ctx.i18n;
  const bytes = ctx.magic?.bytes ?? DEFAULT_STREAM_BYTES;
  const lines: string[] = [];
  const effectiveTick = binaryEnabled ? tick : 0;

  const compact = height < OMR_LOGO_FULL.length + 2 || width < 52;
  const logo = compact ? OMR_LOGO_COMPACT : OMR_LOGO_FULL;
  const logoWidth = compact ? 9 : 28;
  const sideGap = 3;
  const wingWidth = Math.min(
    26,
    Math.floor((width - logoWidth - sideGap * 2) / 2),
  );
  const languageHint = t("hero.languageHint");
  const switchCommands = "/lang en · /lang tr";
  const guides = [
    centerAnsi(renderSupportLine(width, ctx.i18n, theme, ctx.hyperlinks ?? true), width),
    centerAnsi(`${theme.muted}${languageHint && visibleWidth(languageHint) <= width ? languageHint : switchCommands}${theme.reset}`, width),
  ];

  if (height < logo.length + guides.length || width < logoWidth) return guides.slice(0, height);

  // 1. Logo flanked by flowing binary wings
  logo.forEach((logoRow, idx) => {
    const shiftedStops: ReadonlyArray<readonly [number, number, number]> = [
      LOGO_STOPS[(idx + Math.floor(effectiveTick / 6)) % LOGO_STOPS.length]!,
      LOGO_STOPS[
        (idx + 1 + Math.floor(effectiveTick / 6)) % LOGO_STOPS.length
      ]!,
      LOGO_STOPS[
        (idx + 2 + Math.floor(effectiveTick / 6)) % LOGO_STOPS.length
      ]!,
    ];
    const coloredLogo = gradientText(logoRow, shiftedStops, theme, theme.bold);
    if (wingWidth >= 9) {
      const leftWing = renderBinaryLane(
        wingWidth,
        effectiveTick,
        idx,
        bytes,
        theme,
        -1,
      );
      const rightWing = renderBinaryLane(
        wingWidth,
        effectiveTick,
        idx + 3,
        bytes,
        theme,
        1,
      );
      lines.push(
        centerAnsi(
          `${leftWing}${" ".repeat(sideGap)}${coloredLogo}${" ".repeat(sideGap)}${rightWing}`,
          width,
        ),
      );
    } else {
      lines.push(centerAnsi(coloredLogo, width));
    }
  });
  lines.push(...guides);

  // 2. Subtitle / Brand line
  const subtitle = theme.enabled
    ? `${theme.neonMint}${theme.bold}OH-MY-REA${theme.reset} ${theme.subtle}v${VERSION}${theme.reset} ${theme.muted}· ${t("hero.subtitle")}${theme.reset}`
    : `OH-MY-REA v${VERSION} · ${t("hero.subtitle")}`;
  if (lines.length < height) lines.push(centerAnsi(subtitle, width));

  // 3. Live Hex + Binary Disassembler Waterfall Strip
  if (height - lines.length >= 5 && height >= 15 && width >= 44) {
    lines.push("");
    const stripWidth = Math.min(width - 2, 74);
    const stream = ctx.i18n.upper(t("hero.stream"));
    const streamLabel = ctx.magic
      ? ` ${stream} · ${ctx.magic.label.toUpperCase()}${ctx.magic.sizeBytes !== null ? ` · ${formatBytes(ctx.magic.sizeBytes)}` : ""} `
      : ` ${stream} · ${ctx.i18n.upper(t("hero.disassembler"))} `;
    const barFill = Math.max(2, stripWidth - visibleWidth(streamLabel) - 2);
    const leftBar = "─".repeat(Math.floor(barFill / 2));
    const rightBar = "─".repeat(barFill - leftBar.length);
    lines.push(
      centerAnsi(
        `${theme.border}╭${leftBar}${theme.reset}${theme.neonCyan}${streamLabel}${theme.reset}${theme.border}${rightBar}╮${theme.reset}`,
        width,
      ),
    );
    const streamRows = height >= 25 ? 3 : 2;
    for (let r = 0; r < streamRows; r += 1) {
      const byteOffset =
        (Math.floor(effectiveTick / 2) * 2 + r * 6) % bytes.length;
      const inner = padEndAnsi(
        renderHexBitRow(
          stripWidth - 4,
          bytes,
          byteOffset,
          effectiveTick + r,
          theme,
        ),
        stripWidth - 4,
      );
      lines.push(
        centerAnsi(
          `${theme.border}│${theme.reset} ${inner} ${theme.border}│${theme.reset}`,
          width,
        ),
      );
    }
    lines.push(
      centerAnsi(
        `${theme.border}╰${"─".repeat(stripWidth - 2)}╯${theme.reset}`,
        width,
      ),
    );
  }
  if (height - lines.length < 2) return lines;

  // 4. Target + Engine Status Pill Row
  lines.push("");
  const targetName = ctx.target
    ? (ctx.target.split(/[\\/]/).filter(Boolean).at(-1) ?? ctx.target)
    : null;
  const targetBadge = targetName
    ? `${theme.pillMintBg}${theme.neonMint}${theme.bold} ◈ ${targetName} ${theme.reset}`
    : ctx.candidates.length > 0
      ? `${theme.pillAmberBg}${theme.amber} ◇ ${t("hero.candidates", { count: ctx.candidates.length })} ${theme.reset}`
      : `${theme.pillCyanBg}${theme.muted} ○ ${t("hero.noTarget")} ${theme.reset}`;

  const reaBadge = ctx.reaConnected
    ? `${theme.emerald}● ${t("hero.rea", { count: ctx.reaTools })}${theme.reset}`
    : `${theme.amber}◌ ${t("hero.connecting")}${theme.reset}`;

  const shortModel = ctx.model === "no-model" || !ctx.model ? t("status.noModel") : ctx.model.split("/").at(-1) || ctx.model;
  const modelBadge = `${theme.violet}◆ ${shortModel}${theme.reset}`;

  lines.push(centerAnsi(`${targetBadge}  ${reaBadge}  ${modelBadge}`, width));

  // 5. Quick Forensic Workflows Grid
  if (height >= 19 && width >= 54 && height - lines.length >= 4) {
    lines.push("");
    const cardWidth = Math.min(width - 4, 70);
    const colW = Math.floor((cardWidth - 4) / 2);
    const pair = (
      leftCmd: string,
      leftDesc: string,
      rightCmd: string,
      rightDesc: string,
    ): string => {
      const leftCell = padEndAnsi(
        `${theme.neonCyan}${padEndAnsi(leftCmd, 15)}${theme.reset}${theme.muted}${leftDesc}${theme.reset}`,
        colW,
      );
      const rightCell = padEndAnsi(
        `${theme.neonCyan}${padEndAnsi(rightCmd, 15)}${theme.reset}${theme.muted}${rightDesc}${theme.reset}`,
        colW,
      );
      return centerAnsi(`${leftCell}  ${rightCell}`, width);
    };
    lines.push(
      pair("/triage", t("hero.triage"), "/investigate", t("hero.investigate")),
    );
    lines.push(
      pair(
        "/explain <fn>",
        t("hero.explain"),
        "/trace <sym>",
        t("hero.trace"),
      ),
    );
    lines.push(
      pair("/find <text>", t("hero.find"), "/model", t("hero.model")),
    );
    if (height >= 26 && lines.length < height) {
      lines.push(
        pair("/evidence", t("hero.evidence"), "/dashboard", t("hero.dashboard")),
      );
    }
  }

  return lines;
};

/**
 * Render the compact 4-line live binary/hex analyzer strip at the top of the
 * wide-screen right-hand Disassembler HUD rail.
 */
export const renderHudBinaryStrip = (
  width: number,
  tick: number,
  binaryEnabled: boolean,
  magic: TargetMagic | null,
  busy: boolean,
  theme: ColorTheme,
): string[] => {
  const bytes = magic?.bytes ?? DEFAULT_STREAM_BYTES;
  const t = binaryEnabled ? tick : 0;
  const rows: string[] = [];
  rows.push(renderBinaryLane(width, t, 0, bytes, theme, 1));
  rows.push(renderBinaryLane(width, t + (busy ? 3 : 0), 2, bytes, theme, -1));
  const offset = (Math.floor(t / 2) * 4) % bytes.length;
  const addr = `0x${offset.toString(16).padStart(4, "0")}`;
  const hexes: string[] = [];
  const maxBytes = Math.max(2, Math.min(6, Math.floor((width - 8) / 3)));
  for (let i = 0; i < maxBytes; i += 1) {
    const b = bytes[(offset + i) % bytes.length] ?? 0;
    const hi = binaryEnabled && i === t % maxBytes;
    const h = b.toString(16).padStart(2, "0");
    hexes.push(
      theme.enabled
        ? `${hi ? `${theme.bold}${theme.neonMint}` : theme.neonCyan}${h}${theme.reset}`
        : h,
    );
  }
  rows.push(
    truncateAnsi(
      `${theme.indigo}${addr}${theme.reset} ${hexes.join(" ")}`,
      width,
    ),
  );
  return rows;
};
