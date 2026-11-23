/**
 * Pure geometry for in-app mouse selection: which screen cells a selection covers, and
 * word/line ranges for double- and triple-click. Columns are display columns, so wide
 * (CJK/emoji) glyphs count two cells and combining marks count zero.
 */
import { codePointWidth } from "./ansi.js";

/** Where a selection lives: transcript lines scroll with the text; other regions are screen cells. */
export type SelectionRegion = "transcript" | "hud" | "composer";

export interface SelectionPoint {
  readonly line: number;
  readonly col: number;
}

export interface NormalizedSelection {
  readonly startLine: number;
  readonly startCol: number;
  readonly endLine: number;
  readonly endCol: number;
}

/** A highlighted half-open column range `[from, to)` on one frame row. */
export interface RowSpan {
  readonly row: number;
  readonly from: number;
  readonly to: number;
}

/** Orders anchor and focus; `null` when they are the same cell (a plain click, not a selection). */
export const normalizeSelection = (anchor: SelectionPoint, focus: SelectionPoint): NormalizedSelection | null => {
  if (anchor.line === focus.line && anchor.col === focus.col) return null;
  const forward = anchor.line < focus.line || (anchor.line === focus.line && anchor.col <= focus.col);
  const [a, b] = forward ? [anchor, focus] : [focus, anchor];
  return { startLine: a.line, startCol: a.col, endLine: b.line, endCol: b.col };
};

export interface SelectionWindow {
  /** Line index shown on frame row `rowOffset`. */
  readonly firstLine: number;
  readonly height: number;
  readonly rowOffset: number;
  readonly colOffset: number;
  /** Region width in columns; spans are clipped to it. */
  readonly width: number;
}

/**
 * Frame-row spans for the visible part of a line selection. Only cells that hold text are
 * highlighted (up to each line's display width), so padding after a short line stays plain.
 */
export const selectionRowSpans = (
  selection: NormalizedSelection,
  window: SelectionWindow,
  lineWidth: (line: number) => number,
): RowSpan[] => {
  const spans: RowSpan[] = [];
  const first = Math.max(selection.startLine, window.firstLine);
  const last = Math.min(selection.endLine, window.firstLine + window.height - 1);
  for (let line = first; line <= last; line += 1) {
    const width = Math.min(window.width, lineWidth(line));
    const from = Math.max(0, line === selection.startLine ? selection.startCol : 0);
    const to = Math.min(width, line === selection.endLine ? selection.endCol : width);
    if (to > from) {
      spans.push({
        row: window.rowOffset + line - window.firstLine,
        from: window.colOffset + from,
        to: window.colOffset + to,
      });
    }
  }
  return spans;
};

interface Cell {
  readonly text: string;
  readonly col: number;
  readonly width: number;
}

/** Splits plain text into printing cells; zero-width marks join the preceding cell. */
const cellsOf = (plain: string): Cell[] => {
  const cells: Cell[] = [];
  let col = 0;
  for (let i = 0; i < plain.length;) {
    const cp = plain.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    const ch = plain.slice(i, i + step);
    const w = codePointWidth(cp);
    const prev = cells.at(-1);
    if (w === 0 && prev) {
      cells[cells.length - 1] = { ...prev, text: prev.text + ch };
    } else {
      cells.push({ text: ch, col, width: w });
      col += w;
    }
    i += step;
  }
  return cells;
};

// Letters (any script, incl. Turkish ı/ş/ğ), marks, digits, and the path/URL punctuation kitty treats as word characters.
const WORD_CHAR = /^[\p{L}\p{M}\p{N}_@\-./~?&=%+#:]+$/u;
const TRAILING_PUNCT = /^[.,:;?!]$/;

/** Display-column range of the word under `col` (double-click), or `null` on blank space. */
export const wordRangeAt = (plain: string, col: number): { from: number; to: number } | null => {
  const cells = cellsOf(plain);
  const idx = cells.findIndex((cell) => col >= cell.col && col < cell.col + Math.max(1, cell.width));
  if (idx < 0) return null;
  const hit = cells[idx]!;
  if (/^\s+$/u.test(hit.text)) return null;
  if (!WORD_CHAR.test(hit.text)) return { from: hit.col, to: hit.col + hit.width };
  let lo = idx;
  let hi = idx;
  while (lo > 0 && WORD_CHAR.test(cells[lo - 1]!.text)) lo -= 1;
  while (hi < cells.length - 1 && WORD_CHAR.test(cells[hi + 1]!.text)) hi += 1;
  // "end of sentence." selects "sentence", but a lone "." stays selectable.
  while (hi > idx && TRAILING_PUNCT.test(cells[hi]!.text)) hi -= 1;
  return { from: cells[lo]!.col, to: cells[hi]!.col + cells[hi]!.width };
};

/** Display-column range of a line's text without surrounding blanks (triple-click), or `null` if blank. */
export const lineRange = (plain: string): { from: number; to: number } | null => {
  const cells = cellsOf(plain).filter((cell) => !/^\s+$/u.test(cell.text));
  const first = cells[0];
  const last = cells.at(-1);
  return first && last ? { from: first.col, to: last.col + last.width } : null;
};

/** Counts consecutive presses on (nearly) the same cell: 1 = click, 2 = double, 3 = triple, then cycles. */
export class ClickCounter {
  private last: { row: number; col: number; at: number; count: number } | null = null;

  constructor(private readonly intervalMs = 450) {}

  press(row: number, col: number, at: number): number {
    const prev = this.last;
    const repeat = prev !== null && at - prev.at <= this.intervalMs && prev.row === row && Math.abs(prev.col - col) <= 1;
    const count = repeat ? (prev.count % 3) + 1 : 1;
    this.last = { row, col, at, count };
    return count;
  }

  reset(): void {
    this.last = null;
  }
}
