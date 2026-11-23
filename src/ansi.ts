/**
 * Terminal sanitization, Unicode display-width measurement, TrueColor/256-color
 * cyber-forensic theme, and streaming-safe Markdown + code renderer for omr.
 */

export const ESC = "\x1b[";
export const SYNC_START = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";

const ANSI_DECORATION_RE = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OSC8_CLOSE = "\x1b]8;;\x07";

export const terminalLink = (label: string, href: string): string =>
  `\x1b]8;;${href}\x07${label}${OSC8_CLOSE}`;

/** End of a complete OSC 8 sequence, or the original offset. */
const osc8End = (text: string, start: number): number => {
  if (!text.startsWith("\x1b]8;", start)) return start;
  for (let i = start + 4; i < text.length; i += 1) {
    if (text[i] === "\x07") return i + 1;
    if (text[i] === "\x1b") return text[i + 1] === "\\" ? i + 2 : start;
  }
  return start;
};
// Strip all escape sequences (CSI, OSC, DCS/APC/PM, 2-byte ESC) from untrusted text.
const UNSAFE_ESCAPE_RE =
  /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[P_^][\s\S]*?\x1b\\|\x1b\[[0-9;?<=>! ]*[@-~]|\x1b[@-_]|\x1b/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Sanitize untrusted binary strings, command outputs, and model text so raw
 * terminal control sequences can never corrupt the TUI or inject escapes.
 */
export const sanitizeText = (input: string, tabWidth = 2): string => {
  if (!input) return "";
  const normalized = input
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_ESCAPE_RE, "")
    .replace(CONTROL_CHARS_RE, "");
  if (!normalized.includes("\t")) return normalized;
  const spaces = " ".repeat(Math.max(1, tabWidth));
  return normalized.replace(/\t/g, spaces);
};

export const stripAnsi = (input: string): string =>
  input.replace(ANSI_DECORATION_RE, "");

const isZeroWidth = (cp: number): boolean =>
  cp === 0x200b ||
  cp === 0x200c ||
  cp === 0x200d ||
  cp === 0xfeff ||
  (cp >= 0x0300 && cp <= 0x036f) ||
  (cp >= 0x1ab0 && cp <= 0x1aff) ||
  (cp >= 0x1dc0 && cp <= 0x1dff) ||
  (cp >= 0x20d0 && cp <= 0x20ff) ||
  (cp >= 0xfe00 && cp <= 0xfe0f) ||
  (cp >= 0xfe20 && cp <= 0xfe2f);

const isWideCodePoint = (cp: number): boolean =>
  cp >= 0x1100 &&
  (cp <= 0x115f || // Hangul Jamo
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0x3247) ||
    (cp >= 0x3250 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97c) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6b) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f1e6 && cp <= 0x1f1ff) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd));

export const codePointWidth = (cp: number): number => {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isZeroWidth(cp)) return 0;
  return cp === 0x2615 || cp === 0x26a1 || isWideCodePoint(cp) ? 2 : 1; // ☕ and ⚡ have emoji presentation.
};

/** Visual terminal column width, ignoring SGR and OSC 8 decorations. */
export const visibleWidth = (text: string): number => {
  let width = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const c = text.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) {
      width += 1;
      i += 1;
      continue;
    }
    if (c === 0x1b && text.charCodeAt(i + 1) === 0x5b) {
      let end = i + 2;
      while (end < len && text.charCodeAt(end) !== 0x6d) end += 1;
      if (end < len) {
        i = end + 1;
        continue;
      }
    }
    if (c === 0x1b && text.charCodeAt(i + 1) === 0x5d) {
      const end = osc8End(text, i);
      if (end > i) {
        i = end;
        continue;
      }
    }
    const cp = text.codePointAt(i)!;
    width += codePointWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return width;
};

/**
 * Truncate an ANSI-styled or plain string to at most `maxCols` display columns,
 * appending `ellipsis` when clipped and preserving trailing ANSI reset.
 */
export const truncateAnsi = (
  text: string,
  maxCols: number,
  ellipsis = "…",
): string => {
  if (maxCols <= 0) return "";
  if (visibleWidth(text) <= maxCols) return text;
  const ellWidth = visibleWidth(ellipsis);
  const target = Math.max(0, maxCols - ellWidth);
  let cols = 0;
  let hasAnsi = false;
  let hasLink = false;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const c = text.charCodeAt(i);
    if (c === 0x1b && text.charCodeAt(i + 1) === 0x5b) {
      let end = i + 2;
      while (end < len && text.charCodeAt(end) !== 0x6d) end += 1;
      if (end < len) {
        hasAnsi = true;
        i = end + 1;
        continue;
      }
    }
    if (c === 0x1b && text.charCodeAt(i + 1) === 0x5d) {
      const end = osc8End(text, i);
      if (end > i) {
        hasLink = true;
        i = end;
        continue;
      }
    }
    if (c >= 0x20 && c <= 0x7e) {
      if (cols + 1 > target) break;
      cols += 1;
      i += 1;
      continue;
    }
    const cp = text.codePointAt(i)!;
    const w = codePointWidth(cp);
    if (cols + w > target) break;
    cols += w;
    i += cp > 0xffff ? 2 : 1;
  }
  return `${text.slice(0, i)}${hasLink ? OSC8_CLOSE : ""}${hasAnsi ? "\x1b[0m" : ""}${maxCols >= ellWidth ? ellipsis : ""}`;
};

export const padEndAnsi = (text: string, width: number): string => {
  const clipped = truncateAnsi(text, width);
  const pad = Math.max(0, width - visibleWidth(clipped));
  return pad > 0 ? `${clipped}${" ".repeat(pad)}` : clipped;
};

export const centerAnsi = (text: string, width: number): string => {
  const columns = visibleWidth(text);
  if (columns >= width) return truncateAnsi(text, width);
  return `${" ".repeat(Math.floor((width - columns) / 2))}${text}`;
};

/**
 * Extract plain text from an ANSI-styled line between 0-based visual columns `[startCol, endCol)`.
 */
export const slicePlainByVisualCols = (
  text: string,
  startCol: number,
  endCol: number,
): string => {
  if (endCol <= startCol) return "";
  const plain = stripAnsi(text);
  let col = 0;
  let out = "";
  let i = 0;
  while (i < plain.length && col < endCol) {
    const cp = plain.codePointAt(i)!;
    const w = codePointWidth(cp);
    const step = cp > 0xffff ? 2 : 1;
    if (col + w > startCol && col < endCol) {
      out += plain.slice(i, i + step);
    }
    col += w;
    i += step;
  }
  return out;
};

/**
 * Apply inverse/selection highlight SGR across 0-based visual column span `[startCol, endCol)`
 * on an ANSI-styled line without breaking existing SGR sequences or visual width.
 */
export const highlightVisualCols = (
  text: string,
  startCol: number,
  endCol: number,
  highlightOn = "\x1b[7m",
  highlightOff = "\x1b[27m",
): string => {
  if (endCol <= startCol || !text) return text;
  let col = 0;
  let i = 0;
  const len = text.length;
  let inHighlight = false;
  let out = "";
  while (i < len) {
    const c = text.charCodeAt(i);
    if (c === 0x1b && text.charCodeAt(i + 1) === 0x5b) {
      let end = i + 2;
      while (end < len && text.charCodeAt(end) !== 0x6d) end += 1;
      if (end < len) {
        const sgr = text.slice(i, end + 1);
        out += sgr;
        if (inHighlight && (sgr === "\x1b[0m" || sgr === "\x1b[m")) {
          out += highlightOn;
        }
        i = end + 1;
        continue;
      }
    }
    if (c === 0x1b && text.charCodeAt(i + 1) === 0x5d) {
      const end = osc8End(text, i);
      if (end > i) {
        out += text.slice(i, end);
        i = end;
        continue;
      }
    }
    const cp = text.codePointAt(i)!;
    const w = codePointWidth(cp);
    const step = cp > 0xffff ? 2 : 1;
    const shouldHighlight = col + w > startCol && col < endCol;
    if (shouldHighlight && !inHighlight) {
      out += highlightOn;
      inHighlight = true;
    } else if (!shouldHighlight && inHighlight) {
      out += highlightOff;
      inHighlight = false;
    }
    out += text.slice(i, i + step);
    col += w;
    i += step;
  }
  if (inHighlight) out += highlightOff;
  return out;
};

/** Word-wrap plain text in linear O(N) time by visual column width. */
export const wrapPlain = (
  raw: string,
  width: number,
  preSanitized = false,
): string[] => {
  if (width <= 0) return [];
  const text = preSanitized ? raw : sanitizeText(raw);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const pLen = paragraph.length;
    if (pLen === 0) {
      lines.push("");
      continue;
    }
    let leadSpaces = 0;
    while (leadSpaces < pLen && paragraph.charCodeAt(leadSpaces) === 0x20) {
      leadSpaces += 1;
    }
    const baseIndentLen = Math.min(leadSpaces, 12, Math.floor(width / 3));
    const baseIndent =
      baseIndentLen > 0 ? paragraph.slice(0, baseIndentLen) : "";

    let pos = 0;
    let first = true;
    while (pos < pLen) {
      const prefix = first ? "" : baseIndent;
      const budget = Math.max(1, width - prefix.length);
      let cols = 0;
      let i = pos;
      let lastSpace = -1;
      let overflowed = false;

      while (i < pLen) {
        const c = paragraph.charCodeAt(i);
        if (c >= 0x20 && c <= 0x7e) {
          if (cols + 1 > budget) {
            overflowed = true;
            break;
          }
          if (c === 0x20) lastSpace = i;
          cols += 1;
          i += 1;
          continue;
        }
        const cp = paragraph.codePointAt(i)!;
        const w = codePointWidth(cp);
        if (cols + w > budget) {
          overflowed = true;
          break;
        }
        cols += w;
        i += cp > 0xffff ? 2 : 1;
      }

      if (!overflowed) {
        const chunk = paragraph.slice(pos);
        if (chunk.length > 0 || first) lines.push(`${prefix}${chunk}`);
        break;
      }

      const effectiveMinSpace = first
        ? Math.max(pos + 1, leadSpaces + 1)
        : pos + 1;
      const minStep = (paragraph.codePointAt(pos) ?? 0) > 0xffff ? 2 : 1;
      const cut =
        lastSpace >= effectiveMinSpace ? lastSpace : Math.max(pos + minStep, i);
      lines.push(`${prefix}${paragraph.slice(pos, cut).trimEnd()}`);
      pos = cut;
      while (pos < pLen && paragraph.charCodeAt(pos) === 0x20) pos += 1;
      first = false;
    }
  }
  return lines;
};

export interface ColorTheme {
  readonly enabled: boolean;
  readonly trueColor: boolean;
  readonly reset: string;
  readonly bold: string;
  readonly dim: string;
  readonly italic: string;
  readonly underline: string;
  readonly inverse: string;
  // Core cyber-forensic palette
  readonly neonMint: string;
  readonly neonCyan: string;
  readonly indigo: string;
  readonly violet: string;
  readonly sky: string;
  readonly amber: string;
  readonly crimson: string;
  readonly emerald: string;
  readonly fg: string;
  readonly fgBright: string;
  readonly muted: string;
  readonly subtle: string;
  readonly border: string;
  readonly borderActive: string;
  readonly borderFocus: string;
  readonly userBg: string;
  readonly codeBg: string;
  readonly selBg: string;
  readonly pillMintBg: string;
  readonly pillCyanBg: string;
  readonly pillVioletBg: string;
  readonly pillAmberBg: string;
  rgb(r: number, g: number, b: number): string;
  bgRgb(r: number, g: number, b: number): string;
}

export const createTheme = (
  env: NodeJS.ProcessEnv = process.env,
): ColorTheme => {
  const noColor = "NO_COLOR" in env && env["NO_COLOR"] !== "";
  const term = (env["TERM"] ?? "").toLowerCase();
  if (noColor || term === "dumb") {
    const none = "";
    return {
      enabled: false,
      trueColor: false,
      reset: none,
      bold: none,
      dim: none,
      italic: none,
      underline: none,
      inverse: "\x1b[7m",
      neonMint: none,
      neonCyan: none,
      indigo: none,
      violet: none,
      sky: none,
      amber: none,
      crimson: none,
      emerald: none,
      fg: none,
      fgBright: none,
      muted: none,
      subtle: none,
      border: none,
      borderActive: none,
      borderFocus: none,
      userBg: none,
      codeBg: none,
      selBg: "\x1b[7m",
      pillMintBg: none,
      pillCyanBg: none,
      pillVioletBg: none,
      pillAmberBg: none,
      rgb: () => none,
      bgRgb: () => none,
    };
  }

  const colorTerm = (env["COLORTERM"] ?? "").toLowerCase();
  const trueColor =
    Boolean(env["WT_SESSION"]) || env["TERM_PROGRAM"] === "iTerm.app" ||
    colorTerm.includes("truecolor") ||
    colorTerm.includes("24bit") ||
    term.includes("kitty") ||
    term.includes("ghostty") ||
    term.includes("wezterm") ||
    term.includes("alacritty") ||
    term.includes("256color") && env["TERM_PROGRAM"] !== "Apple_Terminal";

  const rgb = (r: number, g: number, b: number): string =>
    trueColor
      ? `\x1b[38;2;${r};${g};${b}m`
      : `\x1b[38;5;${rgbToAnsi256(r, g, b)}m`;
  const bgRgb = (r: number, g: number, b: number): string =>
    trueColor
      ? `\x1b[48;2;${r};${g};${b}m`
      : `\x1b[48;5;${rgbToAnsi256(r, g, b)}m`;

  return {
    enabled: true,
    trueColor,
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    underline: "\x1b[4m",
    inverse: "\x1b[7m",
    neonMint: rgb(0, 245, 160),
    neonCyan: rgb(0, 217, 245),
    indigo: rgb(129, 140, 248),
    violet: rgb(167, 139, 250),
    sky: rgb(56, 189, 248),
    amber: rgb(251, 191, 36),
    crimson: rgb(251, 113, 133),
    emerald: rgb(52, 211, 153),
    fg: rgb(226, 232, 240),
    fgBright: rgb(248, 250, 252),
    muted: rgb(122, 138, 160),
    subtle: rgb(74, 88, 110),
    border: rgb(46, 60, 80),
    borderActive: rgb(28, 128, 148),
    borderFocus: rgb(0, 217, 245),
    userBg: bgRgb(15, 29, 44),
    codeBg: bgRgb(12, 18, 28),
    selBg: bgRgb(18, 42, 62),
    pillMintBg: bgRgb(8, 48, 38),
    pillCyanBg: bgRgb(8, 42, 56),
    pillVioletBg: bgRgb(34, 24, 62),
    pillAmberBg: bgRgb(54, 38, 10),
    rgb,
    bgRgb,
  };
};

const rgbToAnsi256 = (r: number, g: number, b: number): number => {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const ri = Math.round((r / 255) * 5);
  const gi = Math.round((g / 255) * 5);
  const bi = Math.round((b / 255) * 5);
  return 16 + 36 * ri + 6 * gi + bi;
};

/** Interpolate horizontally across RGB stops for crisp logo/header gradients. */
export const gradientText = (
  text: string,
  stops: ReadonlyArray<readonly [number, number, number]>,
  theme: ColorTheme,
  extra = "",
): string => {
  if (!theme.enabled || stops.length === 0 || text.length === 0) return text;
  const chars = [...text];
  const n = Math.max(1, chars.length - 1);
  let out = extra;
  chars.forEach((ch, idx) => {
    if (ch === " ") {
      out += ch;
      return;
    }
    const t = idx / n;
    const scaled = t * (stops.length - 1);
    const seg = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
    const local = scaled - seg;
    const left = stops[seg]!;
    const right = stops[Math.min(stops.length - 1, seg + 1)]!;
    const r = Math.round(left[0] + (right[0] - left[0]) * local);
    const g = Math.round(left[1] + (right[1] - left[1]) * local);
    const b = Math.round(left[2] + (right[2] - left[2]) * local);
    out += `${theme.rgb(r, g, b)}${ch}`;
  });
  return `${out}${theme.reset}`;
};

const CODE_KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "return",
  "break",
  "continue",
  "struct",
  "class",
  "interface",
  "public",
  "private",
  "protected",
  "static",
  "final",
  "void",
  "int",
  "char",
  "long",
  "short",
  "unsigned",
  "signed",
  "uint8_t",
  "uint16_t",
  "uint32_t",
  "uint64_t",
  "size_t",
  "bool",
  "boolean",
  "const",
  "let",
  "var",
  "function",
  "async",
  "await",
  "import",
  "from",
  "export",
  "null",
  "true",
  "false",
  "mov",
  "lea",
  "call",
  "jmp",
  "je",
  "jne",
  "jz",
  "jnz",
  "cmp",
  "test",
  "push",
  "pop",
  "ret",
  "nop",
  "xor",
  "add",
  "sub",
  "ldr",
  "str",
  "bl",
  "cbz",
  "cbnz",
]);

/** Lightweight RE-aware syntax highlighter for single wrapped lines of code. */
export const highlightCodeLine = (line: string, theme: ColorTheme): string => {
  if (!theme.enabled || !line) return line;
  const commentIdx = line.indexOf("//");
  const hashComment =
    line.trimStart().startsWith("#") || line.trimStart().startsWith(";");
  if (hashComment) return `${theme.muted}${theme.italic}${line}${theme.reset}`;
  const codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
  const commentPart = commentIdx >= 0 ? line.slice(commentIdx) : "";

  const tokenRe =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|0x[0-9a-fA-F]+|\bev_[0-9a-f]{12,64}\b|\b\d+\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
  let result = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(codePart)) !== null) {
    if (match.index > last)
      result += `${theme.fg}${codePart.slice(last, match.index)}`;
    const tok = match[0]!;
    if (tok.startsWith('"') || tok.startsWith("'")) {
      result += `${theme.emerald}${tok}${theme.reset}`;
    } else if (tok.startsWith("0x") || tok.startsWith("0X")) {
      result += `${theme.neonCyan}${tok}${theme.reset}`;
    } else if (tok.startsWith("ev_")) {
      result += `${theme.neonMint}${tok}${theme.reset}`;
    } else if (/^\d+$/.test(tok)) {
      result += `${theme.amber}${tok}${theme.reset}`;
    } else if (CODE_KEYWORDS.has(tok)) {
      result += `${theme.violet}${tok}${theme.reset}`;
    } else {
      result += `${theme.fgBright}${tok}${theme.reset}`;
    }
    last = match.index + tok.length;
  }
  if (last < codePart.length)
    result += `${theme.fg}${codePart.slice(last)}${theme.reset}`;
  if (commentPart)
    result += `${theme.muted}${theme.italic}${commentPart}${theme.reset}`;
  return `${result}${theme.reset}`;
};

/** Compact long 67-char `ev_<64hex>` IDs in visual prose while keeping provenance unmistakable. */
export const compactEvidenceTokens = (text: string): string =>
  text.replace(
    /\bev_([0-9a-f]{10})[0-9a-f]{46,50}([0-9a-f]{4})\b/g,
    "⟦ev_$1…$2⟧",
  );

/** Apply inline Markdown + RE provenance styling to a single wrapped prose line. */
export const styleInlineMarkdown = (
  line: string,
  theme: ColorTheme,
  baseColor = theme.fg,
): string => {
  if (!theme.enabled) return line;
  const tokenRe =
    /(⟦ev_[0-9a-f…]+⟧|\bev_[0-9a-f]{8,64}\b|\bunk_[A-Za-z0-9_-]{6,64}\b|`[^`]+`|\*\*[^*]+\*\*|0x[0-9a-fA-F]{3,})/g;
  let out = baseColor;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(line)) !== null) {
    if (match.index > last)
      out += `${baseColor}${line.slice(last, match.index)}`;
    const tok = match[0]!;
    if (tok.startsWith("⟦ev_") || tok.startsWith("ev_")) {
      out += `${theme.pillMintBg}${theme.neonMint}${tok}${theme.reset}${baseColor}`;
    } else if (tok.startsWith("unk_")) {
      out += `${theme.pillAmberBg}${theme.amber}${tok}${theme.reset}${baseColor}`;
    } else if (tok.startsWith("`") && tok.endsWith("`")) {
      out += `${theme.codeBg}${theme.neonCyan}${tok.slice(1, -1)}${theme.reset}${baseColor}`;
    } else if (tok.startsWith("**") && tok.endsWith("**")) {
      out += `${theme.bold}${theme.fgBright}${tok.slice(2, -2)}${theme.reset}${baseColor}`;
    } else if (tok.startsWith("0x")) {
      out += `${theme.sky}${tok}${theme.reset}${baseColor}`;
    } else {
      out += tok;
    }
    last = match.index + tok.length;
  }
  if (last < line.length) out += `${baseColor}${line.slice(last)}`;
  return `${out}${theme.reset}`;
};

const stripInlineMarkersForWrap = (line: string): string =>
  compactEvidenceTokens(line);

type TableColumnAlign = "left" | "center" | "right";

const splitTableCells = (trimmedRow: string): string[] => {
  const inner = trimmedRow.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch === "\\" && inner[i + 1] === "|") {
      cur += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
};

const isTableDelimiterRow = (cells: readonly string[]): boolean =>
  cells.length > 0 &&
  cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));

const parseCellAlignment = (delimCell: string): TableColumnAlign => {
  const t = delimCell.trim();
  if (t.startsWith(":") && t.endsWith(":")) return "center";
  if (t.endsWith(":")) return "right";
  return "left";
};

const alignStyledCell = (
  styledText: string,
  colWidth: number,
  align: TableColumnAlign,
): string => {
  const clipped = truncateAnsi(styledText, colWidth);
  const gap = Math.max(0, colWidth - visibleWidth(clipped));
  if (gap === 0) return clipped;
  if (align === "right") return `${" ".repeat(gap)}${clipped}`;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return `${" ".repeat(left)}${clipped}${" ".repeat(gap - left)}`;
  }
  return `${clipped}${" ".repeat(gap)}`;
};

/**
 * Render a contiguous GFM Markdown table block in `omp` box-table style:
 * aligned column widths, multi-line wrapped cells, bold headers, and `╭┬╮`/`├┼┤`/`╰┴╯` box borders.
 */
const renderMarkdownTableBlock = (
  rawTableLines: readonly string[],
  availableWidth: number,
  theme: ColorTheme,
): string[] => {
  const parsedRows = rawTableLines.map((line) => splitTableCells(line.trim()));
  const delimIdx = parsedRows.findIndex((r) => isTableDelimiterRow(r));
  const numCols = Math.max(
    1,
    ...parsedRows.map((r) => r.length),
  );

  const aligns: TableColumnAlign[] = Array.from(
    { length: numCols },
    (_, colIdx) =>
      delimIdx >= 0 && parsedRows[delimIdx]?.[colIdx]
        ? parseCellAlignment(parsedRows[delimIdx]![colIdx]!)
        : "left",
  );

  const headerRow: string[] | null =
    delimIdx > 0 ? (parsedRows[0] ?? null) : null;
  const bodyRows: string[][] =
    delimIdx > 0
      ? parsedRows
          .slice(1)
          .filter((_, idx) => idx + 1 !== delimIdx && !isTableDelimiterRow(parsedRows[idx + 1]!))
      : parsedRows.filter((r) => !isTableDelimiterRow(r));

  const allContentRows = headerRow ? [headerRow, ...bodyRows] : bodyRows;
  if (allContentRows.length === 0) return [];

  // Border overhead: "│ " + (numCols - 1) * " │ " + " │" = 3 * numCols + 1
  const borderOverhead = 3 * numCols + 1;
  const availableForCells = availableWidth - borderOverhead;
  if (availableForCells < numCols * 2) {
    // Fallback for extremely narrow terminals
    const out: string[] = [];
    for (const row of allContentRows) {
      const joined = row
        .map((c) => styleInlineMarkdown(stripInlineMarkersForWrap(c), theme))
        .join(` ${theme.border}│${theme.reset} `);
      for (const wl of wrapPlain(stripAnsi(joined), Math.max(4, availableWidth), true)) {
        out.push(styleInlineMarkdown(wl, theme));
      }
    }
    return out;
  }

  const naturalWidths = new Array<number>(numCols).fill(3);
  const minWordWidths = new Array<number>(numCols).fill(3);

  for (const row of allContentRows) {
    for (let c = 0; c < numCols; c += 1) {
      const rawCell = stripInlineMarkersForWrap(row[c] ?? "");
      const styledPlain = stripAnsi(styleInlineMarkdown(rawCell, theme));
      naturalWidths[c] = Math.max(
        naturalWidths[c]!,
        visibleWidth(styledPlain),
      );
      for (const word of styledPlain.split(/\s+/)) {
        if (!word) continue;
        minWordWidths[c] = Math.max(
          minWordWidths[c]!,
          Math.min(24, visibleWidth(word)),
        );
      }
    }
  }

  let colWidths: number[];
  const totalNatural = naturalWidths.reduce((a, b) => a + b, 0);
  if (totalNatural <= availableForCells) {
    colWidths = [...naturalWidths];
  } else {
    // Allocate minimum widths first, then distribute remaining space proportionally
    const minSum = minWordWidths.reduce((a, b) => a + b, 0);
    if (minSum <= availableForCells) {
      const extra = availableForCells - minSum;
      const growPotential = naturalWidths.reduce(
        (acc, w, i) => acc + Math.max(0, w - minWordWidths[i]!),
        0,
      );
      colWidths = minWordWidths.map((minW, i) => {
        const delta = Math.max(0, naturalWidths[i]! - minW);
        const add =
          growPotential > 0 ? Math.floor((delta / growPotential) * extra) : 0;
        return minW + add;
      });
    } else {
      // Proportional downscale with a floor of 3 cols per cell
      colWidths = naturalWidths.map((w) =>
        Math.max(3, Math.floor((w / Math.max(1, totalNatural)) * availableForCells)),
      );
    }
    let allocated = colWidths.reduce((a, b) => a + b, 0);
    let colCursor = 0;
    while (allocated < availableForCells) {
      const idx = colCursor % numCols;
      if (colWidths[idx]! < naturalWidths[idx]!) {
        colWidths[idx]! += 1;
        allocated += 1;
      } else if (colCursor >= numCols * 2) {
        break;
      }
      colCursor += 1;
    }
    while (allocated > availableForCells) {
      let widestIdx = 0;
      for (let i = 1; i < numCols; i += 1) {
        if (colWidths[i]! > colWidths[widestIdx]!) widestIdx = i;
      }
      if (colWidths[widestIdx]! <= 2) break;
      colWidths[widestIdx]! -= 1;
      allocated -= 1;
    }
  }

  const b = theme.borderActive;
  const r = theme.reset;
  const topBorder = `${b}╭─${colWidths.map((w) => "─".repeat(w)).join("─┬─")}─╮${r}`;
  const midBorder = `${b}├─${colWidths.map((w) => "─".repeat(w)).join("─┼─")}─┤${r}`;
  const botBorder = `${b}╰─${colWidths.map((w) => "─".repeat(w)).join("─┴─")}─╯${r}`;

  const wrapCellLines = (rawCell: string, colWidth: number, isHeader: boolean): string[] => {
    const cleanCell = stripInlineMarkersForWrap(rawCell);
    const plainWrapped = wrapPlain(cleanCell, Math.max(2, colWidth), true);
    if (plainWrapped.length === 0) return [""];
    return plainWrapped.map((line) =>
      isHeader
        ? `${theme.bold}${theme.neonCyan}${styleInlineMarkdown(line, theme, `${theme.bold}${theme.neonCyan}`)}${r}`
        : styleInlineMarkdown(line, theme),
    );
  };

  const out: string[] = [topBorder];

  const emitRow = (row: readonly string[], isHeader: boolean): void => {
    const wrappedCells = Array.from({ length: numCols }, (_, c) =>
      wrapCellLines(row[c] ?? "", colWidths[c]!, isHeader),
    );
    const height = Math.max(1, ...wrappedCells.map((c) => c.length));
    for (let lineIdx = 0; lineIdx < height; lineIdx += 1) {
      const parts = wrappedCells.map((cellLines, colIdx) =>
        alignStyledCell(
          cellLines[lineIdx] ?? "",
          colWidths[colIdx]!,
          aligns[colIdx]!,
        ),
      );
      out.push(`${b}│${r} ${parts.join(` ${b}│${r} `)} ${b}│${r}`);
    }
  };

  if (headerRow) {
    emitRow(headerRow, true);
    if (bodyRows.length > 0) out.push(midBorder);
  }
  bodyRows.forEach((row, rIdx) => {
    emitRow(row, false);
    if (rIdx < bodyRows.length - 1 && bodyRows.length <= 12) {
      // Subtle row separator when any row in the pair wrapped onto multiple lines
      const multiLine = row.some(
        (cell, cIdx) => visibleWidth(stripInlineMarkersForWrap(cell)) > (colWidths[cIdx] ?? 10),
      );
      if (multiLine) out.push(midBorder);
    }
  });
  out.push(botBorder);
  return out;
};

/**
 * Render assistant Markdown text (including streaming unclosed code blocks,
 * Observed/Inferred/Unresolved headers, bullets, blockquotes, and tables) into
 * styled terminal lines that strictly fit within `width` visual columns.
 */
export const renderMarkdown = (
  raw: string,
  width: number,
  theme: ColorTheme,
  streaming = false,
  preSanitized = false,
  language: "en" | "tr" = "en",
): string[] => {
  if (width <= 4) return [];
  const clean = preSanitized ? raw : sanitizeText(raw);
  if (clean.length === 0) {
    return streaming ? [`${theme.neonCyan}▍${theme.reset}`] : [];
  }

  const lines: string[] = [];
  const rawLines = clean.split("\n");
  let inCode = false;
  let codeLang = "";

  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const line = rawLines[idx]!;
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (!inCode) {
        inCode = true;
        codeLang = trimmed.slice(3).trim() || "code";
        const label = `╭─ ${codeLang} `;
        const fill = "─".repeat(
          Math.max(0, Math.min(width - visibleWidth(label), 28)),
        );
        lines.push(`${theme.borderActive}${label}${fill}${theme.reset}`);
      } else {
        inCode = false;
        codeLang = "";
        const foot = `╰${"─".repeat(Math.min(width - 1, 32))}`;
        lines.push(`${theme.borderActive}${foot}${theme.reset}`);
      }
      continue;
    }

    if (inCode) {
      const innerWidth = Math.max(4, width - 3);
      const wrappedCode = wrapPlain(line, innerWidth, true);
      for (const cl of wrappedCode) {
        lines.push(
          `${theme.borderActive}│${theme.reset} ${highlightCodeLine(cl, theme)}`,
        );
      }
      continue;
    }

    if (trimmed.length === 0) {
      lines.push("");
      continue;
    }

    // Horizontal rule
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      lines.push(
        `${theme.border}${"─".repeat(Math.min(width, 48))}${theme.reset}`,
      );
      continue;
    }

    // Headings with special forensic callout badges for REA sections
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!.trim();
      const lower = title.toLowerCase();
      if (lower.startsWith("observed") || lower.startsWith("gözlemlenen")) {
        lines.push(
          `${theme.pillMintBg}${theme.neonMint}${theme.bold} ◈ ${title.toLocaleUpperCase(language)} ${theme.reset}`,
        );
      } else if (lower.startsWith("inferred") || lower.startsWith("çıkarım")) {
        lines.push(
          `${theme.pillVioletBg}${theme.violet}${theme.bold} ◇ ${title.toLocaleUpperCase(language)} ${theme.reset}`,
        );
      } else if (
        lower.startsWith("unresolved") ||
        lower.startsWith("çözülmemiş") ||
        lower.startsWith("bilinmeyen")
      ) {
        lines.push(
          `${theme.pillAmberBg}${theme.amber}${theme.bold} △ ${title.toLocaleUpperCase(language)} ${theme.reset}`,
        );
      } else if (
        lower.startsWith("not examined") ||
        lower.startsWith("incelenmeyen")
      ) {
        lines.push(
          `${theme.muted}${theme.bold}◌ ${title.toLocaleUpperCase(language)}${theme.reset}`,
        );
      } else if (
        lower.startsWith("recommendation") ||
        lower.startsWith("next step") ||
        lower.startsWith("öneri") ||
        lower.startsWith("sonraki adım")
      ) {
        lines.push(
          `${theme.pillCyanBg}${theme.neonCyan}${theme.bold} ✦ ${title.toLocaleUpperCase(language)} ${theme.reset}`,
        );
      } else {
        const marker = level === 1 ? "◆" : level === 2 ? "◈" : "▸";
        const color =
          level === 1
            ? theme.neonMint
            : level === 2
              ? theme.neonCyan
              : theme.indigo;
        for (const wl of wrapPlain(title, Math.max(4, width - 3), true)) {
          lines.push(`${color}${theme.bold}${marker} ${wl}${theme.reset}`);
        }
      }
      continue;
    }

    // Blockquotes
    if (trimmed.startsWith(">")) {
      const quoteText = stripInlineMarkersForWrap(trimmed.replace(/^>\s?/, ""));
      for (const ql of wrapPlain(quoteText, Math.max(4, width - 3), true)) {
        lines.push(
          `${theme.indigo}▎${theme.reset} ${styleInlineMarkdown(ql, theme, theme.muted)}`,
        );
      }
      continue;
    }

    // Bullet lists
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const depth = Math.min(3, Math.floor(bullet[1]!.length / 2));
      const pad = "  ".repeat(depth);
      const glyph = depth === 0 ? "▸" : "▹";
      const prefixPlain = `${pad}${glyph} `;
      const bodyText = stripInlineMarkersForWrap(bullet[2]!);
      const wrapped = wrapPlain(
        bodyText,
        Math.max(4, width - prefixPlain.length),
        true,
      );
      wrapped.forEach((bl, bIdx) => {
        const lead =
          bIdx === 0
            ? `${pad}${theme.neonCyan}${glyph}${theme.reset} `
            : " ".repeat(prefixPlain.length);
        lines.push(`${lead}${styleInlineMarkdown(bl, theme)}`);
      });
      continue;
    }

    // Numbered lists
    const numbered = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
    if (numbered) {
      const pad = " ".repeat(Math.min(4, numbered[1]!.length));
      const numLabel = `${numbered[2]!} `;
      const prefixLen = pad.length + numLabel.length;
      const bodyText = stripInlineMarkersForWrap(numbered[3]!);
      const wrapped = wrapPlain(bodyText, Math.max(4, width - prefixLen), true);
      wrapped.forEach((nl, nIdx) => {
        const lead =
          nIdx === 0
            ? `${pad}${theme.neonMint}${theme.bold}${numLabel}${theme.reset}`
            : " ".repeat(prefixLen);
        lines.push(`${lead}${styleInlineMarkdown(nl, theme)}`);
      });
      continue;
    }

    // Markdown table block: collect contiguous `| ... |` lines and render as an aligned box table
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const tableBlock: string[] = [trimmed];
      while (idx + 1 < rawLines.length) {
        const nextTrimmed = rawLines[idx + 1]!.trim();
        if (nextTrimmed.startsWith("|") && nextTrimmed.endsWith("|")) {
          tableBlock.push(nextTrimmed);
          idx += 1;
        } else {
          break;
        }
      }
      lines.push(...renderMarkdownTableBlock(tableBlock, width, theme));
      continue;
    }

    // Ordinary paragraph
    const prepared = stripInlineMarkersForWrap(line);
    for (const pl of wrapPlain(prepared, width, true)) {
      lines.push(styleInlineMarkdown(pl, theme));
    }
  }

  if (streaming && lines.length > 0) {
    const lastIdx = lines.length - 1;
    const last = lines[lastIdx]!;
    if (visibleWidth(last) + 1 <= width) {
      lines[lastIdx] = `${last}${theme.neonCyan}▍${theme.reset}`;
    } else {
      lines.push(`${theme.neonCyan}▍${theme.reset}`);
    }
  }

  return lines;
};
