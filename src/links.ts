/**
 * Link detection for rendered TUI lines: plain-text URLs (including ones hard-wrapped across
 * lines) and existing OSC 8 hyperlinks, reported as display-column ranges so a mouse cell can
 * be mapped back to its URL. Only http, https and mailto URLs are ever reported or opened.
 */
import { codePointWidth, stripAnsi, visibleWidth } from "./ansi.js";

export const LINK_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);
const MAX_URL_LENGTH = 2048;

/**
 * Validates and normalizes a URL for opening. Returns `null` unless it parses, uses an allowed
 * scheme, has a host (http/https), carries no credentials, and contains no whitespace or
 * control characters.
 */
export const safeLinkUrl = (raw: string): string | null => {
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  if (/[\s\x00-\x1f\x7f-\x9f]/u.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!LINK_SCHEMES.has(url.protocol)) return null;
  if (url.protocol === "mailto:") return url.pathname.includes("@") ? url.href : null;
  if (!url.hostname || url.username || url.password) return null;
  return url.href;
};

// Characters that can never be part of a detected URL: whitespace, quotes, angle brackets,
// controls, the truncation ellipsis, and box-drawing borders drawn next to text.
const URL_BODY = "[^\\s<>\"'`\\u0000-\\u001f\\u007f-\\u009f\\u2026\\u2500-\\u257f]";
const URL_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:https?://|mailto:)${URL_BODY}+`, "giu");
const URL_TAIL_RE = new RegExp(`^${URL_BODY}+`, "u");
// Prefixes the transcript repeats on wrapped continuation lines (indent, system dot, quote/box bars).
const CONTINUATION_PREFIX_RE = /^[\s·│┃▏]*/u;

const CLOSERS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

/** Removes sentence punctuation and unbalanced closing brackets that follow a URL in prose. */
export const trimUrl = (candidate: string): string => {
  let url = candidate;
  for (;;) {
    const last = url.at(-1);
    if (!last) return url;
    if (/[.,;:!?'"*_~]/.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener && url.split(opener).length - 1 < url.split(last).length - 1) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
};

/** A URL found in plain text, as UTF-16 offsets `[start, end)` plus the normalized URL. */
export interface TextLink {
  readonly start: number;
  readonly end: number;
  readonly url: string;
}

/** URLs in one plain-text line (no wrapping). */
export const findLinks = (plain: string): TextLink[] => {
  const out: TextLink[] = [];
  for (const match of plain.matchAll(URL_RE)) {
    const trimmed = trimUrl(match[0]);
    const url = safeLinkUrl(trimmed);
    if (url) out.push({ start: match.index, end: match.index + trimmed.length, url });
  }
  return out;
};

/** A link occupying display columns `[from, to)` of one rendered line. */
export interface LinkSpan {
  readonly from: number;
  readonly to: number;
  readonly url: string;
  /** True when the line already carries this link as an OSC 8 hyperlink. */
  readonly osc8?: boolean;
}

/** Existing OSC 8 hyperlinks in an ANSI-styled line, as display-column spans. */
export const osc8Spans = (line: string): LinkSpan[] => {
  const spans: LinkSpan[] = [];
  let col = 0;
  let open: { from: number; url: string | null } | null = null;
  for (let i = 0; i < line.length;) {
    if (line.startsWith("\x1b]8;", i)) {
      const bel = line.indexOf("\x07", i);
      const st = line.indexOf("\x1b\\", i);
      const end = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st >= 0 ? st + 2 : -1;
      if (end < 0) break;
      const body = line.slice(i + 4, end - (line[end - 1] === "\x07" ? 1 : 2));
      const href = body.slice(body.indexOf(";") + 1);
      if (open && col > open.from && open.url) spans.push({ from: open.from, to: col, url: open.url, osc8: true });
      open = href ? { from: col, url: safeLinkUrl(href) } : null;
      i = end;
      continue;
    }
    if (line.startsWith("\x1b[", i)) {
      const end = line.indexOf("m", i);
      if (end >= 0) {
        i = end + 1;
        continue;
      }
    }
    const cp = line.codePointAt(i)!;
    col += codePointWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  if (open?.url && col > open.from) spans.push({ from: open.from, to: col, url: open.url, osc8: true });
  return spans;
};

const overlaps = (a: LinkSpan, b: LinkSpan): boolean => a.from < b.to && b.from < a.to;

/**
 * Link spans for rendered lines `[first, last)` of `lines`. A URL that runs to the end of a full
 * line (display width >= `width - 2`, i.e. it was hard-wrapped) continues at the start of the next
 * line after the transcript's continuation prefix, and both pieces map to the whole URL. Up to
 * `lookBehind` earlier lines are scanned so a URL wrapped into the first visible line is found.
 */
export const linkSpansForLines = (
  lines: readonly string[],
  first: number,
  last: number,
  width: number,
  lookBehind = 6,
): Map<number, LinkSpan[]> => {
  const result = new Map<number, LinkSpan[]>();
  const plainCache = new Map<number, string>();
  const plainAt = (idx: number): string => {
    let plain = plainCache.get(idx);
    if (plain === undefined) {
      plain = stripAnsi(lines[idx] ?? "");
      plainCache.set(idx, plain);
    }
    return plain;
  };
  const isFull = (idx: number): boolean => visibleWidth(plainAt(idx)) >= width - 2;
  const add = (idx: number, span: LinkSpan): void => {
    if (idx < first || idx >= last) return;
    const list = result.get(idx) ?? [];
    if (!list.some((existing) => overlaps(existing, span))) list.push(span);
    result.set(idx, list);
  };
  // Offset already consumed on a line by a URL continued from the line above.
  const consumed = new Map<number, number>();
  const end = Math.min(lines.length, last);
  for (let idx = Math.max(0, first - lookBehind); idx < end; idx += 1) {
    for (const span of osc8Spans(lines[idx] ?? "")) add(idx, span);
    const plain = plainAt(idx);
    const startAt = consumed.get(idx) ?? 0;
    for (const match of plain.slice(startAt).matchAll(URL_RE)) {
      const segments: { line: number; start: number; end: number }[] = [
        { line: idx, start: startAt + match.index, end: startAt + match.index + match[0].length },
      ];
      let text = match[0];
      let tailLine = idx;
      while (
        segments.at(-1)!.end >= plainAt(tailLine).trimEnd().length &&
        isFull(tailLine) &&
        tailLine + 1 < lines.length
      ) {
        const next = plainAt(tailLine + 1);
        const prefix = CONTINUATION_PREFIX_RE.exec(next)![0].length;
        const tail = URL_TAIL_RE.exec(next.slice(prefix));
        if (!tail || /^(?:https?:\/\/|mailto:)/i.test(tail[0])) break;
        tailLine += 1;
        segments.push({ line: tailLine, start: prefix, end: prefix + tail[0].length });
        text += tail[0];
      }
      const trimmed = trimUrl(text);
      const url = safeLinkUrl(trimmed);
      if (!url) continue;
      let excess = text.length - trimmed.length;
      while (excess > 0 && segments.length > 0) {
        const seg = segments.at(-1)!;
        const take = Math.min(excess, seg.end - seg.start);
        excess -= take;
        if (take === seg.end - seg.start) segments.pop();
        else segments[segments.length - 1] = { ...seg, end: seg.end - take };
      }
      for (const seg of segments) {
        const line = plainAt(seg.line);
        const from = visibleWidth(line.slice(0, seg.start));
        add(seg.line, { from, to: from + visibleWidth(line.slice(seg.start, seg.end)), url });
        if (seg.line !== idx) consumed.set(seg.line, seg.end);
      }
    }
  }
  for (const list of result.values()) list.sort((a, b) => a.from - b.from);
  return result;
};

/** Link under display column `col`, if any. */
export const linkAt = (spans: readonly LinkSpan[] | undefined, col: number): LinkSpan | null =>
  spans?.find((span) => col >= span.from && col < span.to) ?? null;
