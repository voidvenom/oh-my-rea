/** Identical read-only calls allowed per turn; the next one is answered by the guard instead of REA. */
export const LOOP_LIMIT = 2;
/** Consecutive identical failures allowed for a non-read-only call. */
export const LOOP_FAILURE_LIMIT = 2;

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
 * Per-turn guard against a model re-issuing the same call. REA answers identical read-only calls
 * identically until session state changes, so the third copy only burns a step. Any successful
 * state-changing call clears the history because later results may legitimately differ.
 */
export class LoopGuard {
  private readonly seen = new Map<string, Seen>();

  private static key(name: string, args: Record<string, unknown>): string {
    return `${name}\n${stable(args)}`;
  }

  /** Message to return instead of executing the call, or `null` to let it run. */
  check(
    name: string,
    args: Record<string, unknown>,
    readOnly: boolean,
  ): string | null {
    const entry = this.seen.get(LoopGuard.key(name, args));
    if (!entry) return null;
    if (readOnly && entry.executed >= LOOP_LIMIT) {
      return (
        `[omr loop guard] \`${name}\` already ran ${entry.executed} times this turn with identical ` +
        "arguments and returned the same data. Use the earlier result, change the arguments, or choose a different tool."
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
    this.seen.set(key, entry);
  }

  clear(): void {
    this.seen.clear();
  }
}
