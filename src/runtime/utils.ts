import type { CompactionReport } from "../agent.js";
import { formatTokenCountShort } from "../compaction.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../rea.js";

export const splitShellTokens = (input: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        current += input[i + 1]!;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
};

export const toolTimeoutMs = (env: NodeJS.ProcessEnv): number => {
  const value = env["OMR_TOOL_TIMEOUT_MS"]?.trim();
  if (value === "0") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1_000
    ? Math.trunc(parsed)
    : DEFAULT_TOOL_TIMEOUT_MS;
};

export const errorMessageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const formatDurationShort = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;

export const describeCompaction = (report: CompactionReport): string => {
  const before = formatTokenCountShort(report.beforeTokens);
  const after = formatTokenCountShort(report.afterTokens);
  const saved =
    report.beforeTokens > 0
      ? Math.max(
          0,
          Math.round((1 - report.afterTokens / report.beforeTokens) * 100),
        )
      : 0;
  const modelTag = report.compactionModel
    ? ` via ${report.compactionModel}`
    : "";
  const parts = [
    `context compacted (${report.strategy}${report.auto ? ", auto" : ""}${modelTag}): ${before} → ${after} tokens (−${saved}%)`,
  ];
  if (report.frames && report.frames > 0)
    parts.push(`${report.frames} bitmap frame(s)`);
  if (report.summarizedMessages > 0)
    parts.push(`${report.summarizedMessages} messages archived`);
  if (report.shake)
    parts.push(`${report.shake.compactedTools} tool outputs stubbed`);
  if (report.shake && report.shake.droppedTurns > 0)
    parts.push(`${report.shake.droppedTurns} old turns evicted`);
  parts.push(formatDurationShort(report.durationMs));
  const note = report.note ? ` — ${report.note}` : "";
  return `${parts.join(" · ")}${note}. All ev_/unk_ IDs preserved.`;
};
