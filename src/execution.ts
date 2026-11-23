import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { ChatMessage } from "./model.js";
import { asArray, asRecord, asString } from "./values.js";
import { ConcurrencyLimiter } from "./concurrency.js";
import { canSyncDirectory } from "./platformFs.js";

export interface ExecutionEvent {
  readonly schema: 1;
  readonly seq: number;
  readonly id: string;
  readonly at: string;
  readonly sessionId: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface InvocationIntent {
  readonly id: string;
  readonly backend: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly argsDigest: string;
  readonly readOnly: boolean;
  readonly binding: unknown;
  readonly startedAt: string;
}

export interface ExecutionObservation {
  readonly event: ExecutionEvent;
  readonly invocation: InvocationIntent | null;
  readonly replayed: boolean;
}
const freezeTree = (root: object): void => {
  const pending = [root];
  while (pending.length) {
    const value = pending.pop()!; if (Object.isFrozen(value)) continue;
    Object.freeze(value);
    for (const item of Object.values(value)) if (item && typeof item === "object") pending.push(item);
  }
};

export class UncertainInvocationError extends Error {
  constructor(readonly invocationId: string, cause?: unknown) {
    super(`Invocation ${invocationId} has an uncertain outcome; inspect the execution trace and reconcile it before repeating a side effect.`, {cause});
    this.name = "UncertainInvocationError";
  }
}

/** Only raised by a dispatcher that knows no backend request or side effect was sent. */
export class InvocationNotDispatchedError extends Error {
  constructor(message: string) { super(message); this.name = "InvocationNotDispatchedError"; }
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = asRecord(value);
  return record ? `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}` : JSON.stringify(value);
};
/** Matches REA's canonical JSON argument digest, independent of insertion order. */
export const argumentDigest = (value: unknown): string =>
  createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value ?? null)))).digest("hex");

const projectionDigest = (message: string): string => createHash("sha256").update(message).digest("hex");

const eventOf = (line: string): ExecutionEvent => {
  const raw = asRecord(JSON.parse(line));
  if (raw?.["schema"] !== 1 || !Number.isInteger(raw["seq"]) || typeof raw["id"] !== "string" || typeof raw["at"] !== "string" || typeof raw["sessionId"] !== "string" || typeof raw["type"] !== "string" || !asRecord(raw["data"])) {
    throw new Error("Invalid committed execution trace record");
  }
  return raw as unknown as ExecutionEvent;
};

async function* readNativeRecords(path: string): AsyncGenerator<Record<string, unknown>> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const record = asRecord(JSON.parse(line));
        if (record) yield record;
      } catch {
        // Native journals may contain a partially written last record.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Explicit replay/export API; normal writes retain only digests and pending intents in memory. */
export async function* readExecutionEvents(path: string): AsyncGenerator<ExecutionEvent> {
  let size: number; try { size = (await stat(path)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!size) return;
  const stream = createReadStream(path, {encoding: "utf8", end: size - 1}); let pending = "";
  try { for await (const chunk of stream) {pending += chunk; let newline: number; while ((newline = pending.indexOf("\n")) >= 0) {const line = pending.slice(0, newline);pending = pending.slice(newline + 1);if (line.trim()) yield eventOf(line);}} }
  finally { stream.destroy(); }
  // An unterminated suffix is not a committed event; initialize archives/repairs it.
}

/** fsync-before-dispatch write-ahead log and append-only canonical conversation store. */
export class ExecutionStore {
  readonly path: string;
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<string, InvocationIntent>();
  private readonly projections = new Map<string, string[]>();
  private readonly admission = new ConcurrencyLimiter(1);
  private readonly historyWriters = new Map<string, ConcurrencyLimiter>();
  private readonly activeInvocations = new Set<string>();
  private readonly reconciliations: string[] = [];
  private readonly observers = new Set<(observation: ExecutionObservation) => void>();
  private readonly observationErrors: string[] = [];

  constructor(readonly sessionId: string, readonly directory: string) { this.path = join(directory, "execution.jsonl"); }

  /** Synchronous committed-event observations. Subscribe before initialize to include replay. */
  observe(listener: (observation: ExecutionObservation) => void): () => void {
    this.observers.add(listener); return () => { this.observers.delete(listener); };
  }
  observerErrors(): readonly string[] { return [...this.observationErrors]; }
  get committedSequence(): number { return this.sequence; }

  initialize(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      // Only a newline-terminated, fsynced record is committed. Preserve an interrupted
      // suffix separately before repairing the next append boundary.
      let info;
      try { info = await stat(this.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (info.size > 0) {
        const file = await open(this.path, "r+");
        let boundary = info.size;
        try {
          const last = Buffer.alloc(1); await file.read(last, 0, 1, info.size - 1);
          if (last[0] !== 10) {
            let offset = info.size;
            while (offset > 0) {
              const length = Math.min(64 * 1024, offset); offset -= length;
              const buf = Buffer.alloc(length); await file.read(buf, 0, length, offset);
              const newline = buf.lastIndexOf(10);
              if (newline >= 0) { boundary = offset + newline + 1; break; }
              boundary = 0;
            }
            const archive = await open(`${this.path}.partial-${randomUUID()}`, "wx", 0o600);
            try {
              const chunk = Buffer.alloc(64 * 1024);
              let position = boundary;
              while (position < info.size) {
                const size = Math.min(chunk.length, info.size - position);
                const { bytesRead } = await file.read(chunk, 0, size, position);
                if (!bytesRead) throw new Error("Execution trace changed while recovering a partial record");
                await archive.writeFile(chunk.subarray(0, bytesRead));
                position += bytesRead;
              }
              await archive.sync();
            } finally { await archive.close(); }
            await file.truncate(boundary); await file.sync();
          }
        } finally { await file.close(); }
      }
      for await (const event of readExecutionEvents(this.path)) {
        if (event.seq <= this.sequence) throw new Error("Execution trace sequence is not monotonic");
        this.sequence = event.seq; this.apply(event, true);
      }
    })();
    return this.ready;
  }

  private apply(event: ExecutionEvent, replayed = false): void {
    const invocation = this.pending.get(asString(event.data["id"])) ?? null;
    if (event.type === "invocation.started") {
      const intent = event.data as unknown as InvocationIntent;
      if (typeof intent.id !== "string" || typeof intent.backend !== "string" || typeof intent.tool !== "string" || typeof intent.readOnly !== "boolean" || !asRecord(intent.args) || typeof intent.argsDigest !== "string") {
        throw new Error("Invalid committed invocation intent; recovery requires inspection");
      }
      this.pending.set(intent.id, intent);
    } else if (["invocation.completed", "invocation.failed", "invocation.not_dispatched", "invocation.resolved"].includes(event.type)) {
      this.pending.delete(asString(event.data["id"]));
    }
    if (event.type === "invocation.resolved") {
      const resolution = asString(event.data["resolution"]);
      this.reconciliations.push(`Invocation ${asString(event.data["id"])} (${asString(event.data["tool"])}) reconciled as ${resolution}: ${asString(event.data["note"])}. ${resolution === "retry" ? "The operator explicitly authorized retry." : "Original result payload may be unavailable; do not repeat the completed side effect."}`);
      if (this.reconciliations.length > 20) this.reconciliations.shift();
    }
    const scope = asString(event.data["scope"]);
    if (event.type === "conversation.append" || event.type === "projection.reset") {
      const hashes = asArray(event.data["messages"]).map(message => projectionDigest(JSON.stringify(message)));
      this.projections.set(scope, event.type === "projection.reset" ? hashes : [...(this.projections.get(scope) ?? []), ...hashes]);
    }
    if (this.observers.size) {
      freezeTree(event); if (invocation) freezeTree(invocation);
      for (const observer of [...this.observers]) {
        if (!this.observers.has(observer)) continue;
        const failed = (error: unknown): void => {
          this.observers.delete(observer); this.observationErrors.push(error instanceof Error ? error.message : String(error));
          if (this.observationErrors.length > 10) this.observationErrors.shift();
        };
        try { const result = (observer as (value: ExecutionObservation) => unknown)({event, invocation, replayed}); if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).catch(failed); }
        catch (error) { failed(error); }
      }
    }
  }

  append(type: string, data: Record<string, unknown>): Promise<ExecutionEvent> {
    const snapshot = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    const write = this.queue.then(async () => {
      await this.initialize();
      const event: ExecutionEvent = {schema: 1, seq: this.sequence + 1, id: randomUUID(), at: new Date().toISOString(), sessionId: this.sessionId, type, data: snapshot};
      const file = await open(this.path, "a", 0o600);
      try { await file.writeFile(`${JSON.stringify(event)}\n`); await file.sync(); }
      finally { await file.close(); }
      if (this.sequence === 0 && canSyncDirectory()) {
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      this.sequence = event.seq; this.apply(event);
      return event;
    });
    // A persistence failure poisons this writer: never dispatch another side effect
    // through a log whose committed boundary is unknown.
    this.queue = write.then(() => {});
    void this.queue.catch(() => {});
    return write;
  }

  async captureConversation(scope: string, messages: readonly ChatMessage[], reason: string): Promise<void> {
    let writer = this.historyWriters.get(scope);
    if (!writer) { writer = new ConcurrencyLimiter(1); this.historyWriters.set(scope, writer); }
    // Capture before waiting for the writer. Only changed records need to be parsed and published.
    const projection = messages.filter(message => message.role !== "system").map(message => JSON.stringify(message));
    await writer.run(() => this.captureProjection(scope, projection, reason));
  }

  private async captureProjection(scope: string, projection: readonly string[], reason: string): Promise<void> {
    await this.initialize();
    const hashes = projection.map(projectionDigest);
    const previous = this.projections.get(scope) ?? [];
    let common = 0;
    while (common < previous.length && common < hashes.length && previous[common] === hashes[common]) common++;
    if (common === previous.length && common === hashes.length) return;
    const append = common === previous.length;
    const messages = projection.slice(append ? common : 0).map(message => JSON.parse(message) as ChatMessage);
    await this.append(append ? "conversation.append" : "projection.reset", { scope, reason, messages });
  }

  async unresolved(): Promise<readonly InvocationIntent[]> { await this.initialize(); await this.queue; return [...this.pending.values()]; }
  async recoveryPending(): Promise<readonly InvocationIntent[]> { return (await this.unresolved()).filter((intent) => !this.activeInvocations.has(intent.id)); }

  async invoke<T>(request: Omit<InvocationIntent, "id" | "argsDigest" | "startedAt">, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const intent = await this.admission.run(async () => {
      await this.initialize();
      const digest = argumentDigest(request.args);
      const duplicate = [...this.pending.values()].find((intent) => !intent.readOnly && intent.backend === request.backend && intent.tool === request.tool && intent.argsDigest === digest);
      if (duplicate) throw new UncertainInvocationError(duplicate.id);
      const started: InvocationIntent = {...request, id: randomUUID(), argsDigest: digest, startedAt: new Date().toISOString()};
      await this.append("invocation.started", {...started});
      return started;
    }, signal);
    this.activeInvocations.add(intent.id);
    try {
    if (signal?.aborted) {
      await this.append("invocation.not_dispatched", {id: intent.id, reason: "cancelled before dispatch"});
      signal.throwIfAborted();
    }
    let result: T;
    try { result = await work(); }
    catch (error) {
      if (error instanceof InvocationNotDispatchedError) {
        await this.append("invocation.not_dispatched", {id: intent.id, reason: error.message});
        throw error;
      }
      if (request.readOnly) {
        await this.append("invocation.failed", {id: intent.id, reason: error instanceof Error ? error.message : String(error)});
        throw error;
      }
      await this.append("invocation.uncertain", {id: intent.id, reason: error instanceof Error ? error.message : String(error)});
      throw new UncertainInvocationError(intent.id, error);
    }
    try { await this.append("invocation.completed", {id: intent.id, result}); }
    catch (error) { throw new UncertainInvocationError(intent.id, error); }
    return result;
    } finally { this.activeInvocations.delete(intent.id); }
  }

  async resolve(id: string, resolution: "completed" | "retry", note: string): Promise<void> {
    await this.initialize();
    if (!this.pending.has(id)) throw new Error(`No unresolved invocation ${id}`);
    if (this.activeInvocations.has(id)) throw new Error(`Invocation ${id} is still running and cannot be reconciled`);
    if (!note.trim()) throw new Error("Reconciliation requires an observation or operator decision");
    await this.append("invocation.resolved", {id, resolution, note, tool: this.pending.get(id)!.tool});
  }

  recoveryNote(): string | null { return this.reconciliations.length > 0 ? `[execution recovery]\n${this.reconciliations.join("\n")}` : null; }

  /** Native journal candidates aid inspection; a digest match alone cannot prove call ownership. */
  async reconcileNativeJournal(path: string): Promise<ReadonlyArray<{intent: InvocationIntent; candidates: readonly Record<string, unknown>[]}>> {
    const pending = await this.unresolved();
    const matches = pending.map(intent => ({ intent, candidates: [] as Record<string, unknown>[] }));
    if (!matches.length) return matches;
    const calls = new Map<unknown, Set<(typeof matches)[number]>>();
    for await (const record of readNativeRecords(path)) {
      if (record["type"] !== "tool.call") continue;
      const id = record["call_id"];
      for (const match of matches) {
        if (record["tool"] !== match.intent.tool || record["args_digest"] !== match.intent.argsDigest) continue;
        let belonging = calls.get(id);
        if (!belonging) { belonging = new Set(); calls.set(id, belonging); }
        belonging.add(match);
      }
    }
    if (!calls.size) return matches;
    for await (const record of readNativeRecords(path)) {
      if (record["type"] !== "tool.result") continue;
      for (const match of calls.get(record["call_id"]) ?? []) match.candidates.push(record);
    }
    return matches;
  }

  async flush(): Promise<void> { await this.queue; }
}
