import { createHash } from "node:crypto";

/** Identical read-only calls before the model is nudged (the call still runs; the guard never blocks or ends a turn). */
export const LOOP_LIMIT = 2;
/** Consecutive identical failures of a non-read-only call before the model is nudged. */
export const LOOP_FAILURE_LIMIT = 2;

/**
 * Tools that observe live external state (a browser page, a running process). Their answer legitimately
 * changes between identical calls (polling `document.readyState`, re-taking a snapshot after a wait), so
 * they get a looser limit than REA's session-deterministic reads.
 */
const LIVE_STATE_TOOL = /(^|_)(evaluate|snapshot|screenshot|get_text|console|network|status|tabs|logs?)$/;
/** Distinct call signatures remembered per turn (oldest evicted). */
const MAX_TRACKED_CALLS = 4096;
/** Identical live-state calls allowed per turn before the guard intervenes. */
export const LIVE_LOOP_LIMIT = 8;

const effectiveTool = (name: string, args: Record<string, unknown>): string => {
  const inner = name === "rea_call" ? args["name"] : name;
  return typeof inner === "string" ? inner : name;
};

const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
};

interface Seen {
  executed: number;
  consecutiveFailures: number;
}

/**
 * Per-turn detector for a model re-issuing the same call. REA answers identical read-only calls
 * identically until session state changes, so the third copy is usually a loop; the caller prefixes a
 * warning to the result but still executes the call. Any successful state-changing call clears the
 * history because later results may legitimately differ.
 */
export class LoopGuard {
  private readonly seen = new Map<string, Seen>();

  private static key(name: string, args: Record<string, unknown>): string {
    // Hashed so a 500-round turn with large script bodies does not retain every argument payload.
    return createHash("sha1").update(`${name}\n${stable(args)}`).digest("base64");
  }

  /** Warning to attach to the call's result, or `null` when the call is not a repeat. */
  check(
    name: string,
    args: Record<string, unknown>,
    readOnly: boolean,
  ): string | null {
    if (name === "omr_run" && typeof args["run_id"] === "string" && args["action"] !== "cancel") return null;
    if (name === "omr_task" && ["wait", "status", "graph", "inspect"].includes(String(args["action"]))) return null;
    const entry = this.seen.get(LoopGuard.key(name, args));
    if (!entry) return null;
    const limit = LIVE_STATE_TOOL.test(effectiveTool(name, args)) ? LIVE_LOOP_LIMIT : LOOP_LIMIT;
    if (readOnly && entry.executed >= limit) {
      return (
        `[omr loop guard] \`${name}\` already ran ${entry.executed} times this turn with identical ` +
        "arguments and likely returned the same data. Use the earlier result, change the arguments, or choose a different tool."
      );
    }
    if (!readOnly && entry.consecutiveFailures >= LOOP_FAILURE_LIMIT) {
      return (
        `[omr loop guard] \`${name}\` failed ${entry.consecutiveFailures} times in a row with identical ` +
        "arguments. Change the arguments or the tool; `rea_tools { query }` can find alternatives."
      );
    }
    return null;
  }

  record(
    name: string,
    args: Record<string, unknown>,
    readOnly: boolean,
    isError: boolean,
  ): void {
    if (!readOnly && !isError) this.seen.clear();
    const key = LoopGuard.key(name, args);
    const entry = this.seen.get(key) ?? { executed: 0, consecutiveFailures: 0 };
    entry.executed += 1;
    entry.consecutiveFailures = isError ? entry.consecutiveFailures + 1 : 0;
    this.seen.delete(key);
    this.seen.set(key, entry);
    // Bounded: evict the oldest entry so unbounded turns cannot grow this map without limit.
    if (this.seen.size > MAX_TRACKED_CALLS) this.seen.delete(this.seen.keys().next().value as string);
  }

  clear(): void {
    this.seen.clear();
  }
}
