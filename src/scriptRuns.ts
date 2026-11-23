import { randomUUID } from "node:crypto";
import { normalize } from "node:path";
import type { BrokerOutcome } from "./broker.js";
import type { RunProgress } from "./exec.js";

type Finished = { outcome: BrokerOutcome } | { error: unknown };
type Run = {
  readonly script: string;
  readonly waiters: Set<() => void>;
  readonly settled: Promise<void>;
  readonly cancellation: AbortController;
  output?: () => RunProgress;
  finished?: Finished;
};

/** A session owns running scripts independently of the tool call that waits for them. */
export class SessionScriptRuns {
  private readonly lifecycle = new AbortController();
  private readonly runs = new Map<string, Run>();
  private readonly finishedIds: string[] = [];

  start(
    script: string,
    execute: (signal: AbortSignal, onStart: (output: () => RunProgress) => void) => Promise<BrokerOutcome>,
    signal?: AbortSignal,
  ): string {
    const cancellation = new AbortController();
    const signals = [cancellation.signal, this.lifecycle.signal];
    if (signal) signals.push(signal);
    const owner = AbortSignal.any(signals);
    owner.throwIfAborted();
    for (const [id, run] of this.runs) {
      if (!run.finished && normalize(run.script) === normalize(script)) {
        throw new Error(`Script ${script} is already active. Wait for run_id ${id} or use a different script file.`);
      }
    }
    const id = randomUUID();
    const finish = (finished: Finished): void => {
      run.finished = finished;
      delete run.output;
      for (const notify of run.waiters) notify();
      this.finishedIds.push(id);
      if (this.finishedIds.length > 32) this.runs.delete(this.finishedIds.shift()!);
    };
    const settled = Promise.resolve().then(() => execute(owner, (output) => { run.output = output; }))
      .then((outcome) => finish({ outcome }), (error: unknown) => finish({ error }));
    const run: Run = { script, waiters: new Set(), settled, cancellation };
    this.runs.set(id, run);
    return id;
  }

  cancel(id: string): void {
    const run = this.runs.get(id);
    if (run && !run.finished) run.cancellation.abort(new Error("Script explicitly cancelled"));
  }

  async wait(id: string, waitMs: number, signal?: AbortSignal): Promise<BrokerOutcome | null> {
    signal?.throwIfAborted();
    const run = this.runs.get(id);
    if (!run) return null;
    if (!run.finished && waitMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          run.waiters.delete(finish);
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const finish = (): void => { cleanup(); resolve(); };
        const onAbort = (): void => { cleanup(); reject(signal?.reason); };
        const timer = setTimeout(finish, waitMs);
        run.waiters.add(finish);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (run.finished) {
      if ("error" in run.finished) throw run.finished.error;
      const { outcome } = run.finished;
      return { ...outcome, text: `${outcome.text}\nrun_id: ${id}`,
        structuredContent: { run_id: id, status: outcome.isError ? "failed" : "completed" } };
    }
    const output = run.output?.();
    return {
      tool: "omr_run", isError: false, durationMs: output?.durationMs ?? 0, evidenceIds: [],
      text: [
        `omr_run ${run.script} is ${output ? "still running" : "queued"}.`,
        `Check progress with omr_run { run_id: "${id}", wait_s: 0 } or wait again for completion.`,
        `--- stdout so far ---\n${output?.stdout || "(empty)"}`,
        `--- stderr so far ---\n${output?.stderr || "(empty)"}`,
      ].join("\n"),
      structuredContent: { run_id: id, status: output ? "running" : "queued" },
    };
  }

  async close(): Promise<void> {
    this.lifecycle.abort();
    await Promise.all([...this.runs.values()].map((run) => run.settled));
  }
}
