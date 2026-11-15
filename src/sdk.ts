import { resolve } from "node:path";
import { parseArgs } from "./args.js";
import { resolveReaEnv } from "./env.js";
import { readExecutionEvents, type ExecutionEvent, type ExecutionObservation, type ExecutionStore } from "./execution.js";
import type { ChatImageBlock, ModelPort, SessionUsageView } from "./model.js";
import type { ModelConfig } from "./modelConfig.js";
import { exitCodeFor, type ExecutionOutcome } from "./outcome.js";
import type { ReaConnectOptions, ReaPort } from "./rea.js";
import { createDefaultCommandRegistry } from "./runtime.js";
import { OmrContext } from "./runtime/context.js";
import { OutputSink } from "./runtime/output.js";
import type { EvidenceOrigin } from "./runtime/sessionRuntime.js";
import { createSession } from "./session.js";
import type { TaskState } from "./taskState.js";
import { resources } from "./resources.js";

export { configureResourceLimits, DEFAULT_RESOURCE_LIMITS } from "./resources.js";
export type { ResourceKind, ResourceLimits, ResourceSnapshot } from "./resources.js";
export type { ExecutionEvent, ExecutionObservation } from "./execution.js";
export type { ChatImageBlock, ModelPort, ChatMessage, StreamResult, ToolDefinition, Usage } from "./model.js";
export type { ReaPort, ReaCallOptions, ReaCallResult, ReaTool } from "./rea.js";
export type { TaskState, TaskEntry, TaskArtifact } from "./taskState.js";
export type { ExecutionOutcome, ExecutionStatus } from "./outcome.js";
export type { InvestigationSnapshot, InvestigationLedger, AnalysisScope } from "./investigation.js";

export interface RuntimeOutput { readonly schema: "omr-output/v1"; readonly stream: "stdout" | "stderr"; readonly text: string; }
export interface RuntimeOptions {
  readonly cwd?: string; readonly sessionsRootDir?: string; readonly target?: string | null;
  readonly env?: NodeJS.ProcessEnv; readonly model?: string; readonly noModel?: boolean; readonly resume?: string;
  readonly onOutput?: (output: RuntimeOutput) => void;
  readonly onEvent?: (observation: ExecutionObservation) => void;
  /** Optional in-process adapters; they obey the same lifecycle/accounting contracts as the CLI. */
  readonly adapters?: { readonly createModelClient?: (config: ModelConfig) => ModelPort; readonly connectRea?: (directory: string, env: NodeJS.ProcessEnv, sources: string[], options: ReaConnectOptions) => Promise<ReaPort>; };
}
export interface RuntimeSession { readonly id: string; readonly directory: string; readonly target: string | null; }
export interface RuntimeResult { readonly schema: "omr-runtime/v1"; readonly session: RuntimeSession; readonly outcome: ExecutionOutcome; readonly exitCode: number; readonly text: string; readonly commandResult: unknown; }
export interface RuntimeSnapshot { readonly schema: "omr-runtime/v1"; readonly session: RuntimeSession; readonly task: TaskState; readonly usage: SessionUsageView; readonly origin: EvidenceOrigin | null; readonly resources: ReturnType<typeof resources.snapshot>; readonly investigation: import("./investigation.js").InvestigationSnapshot; }
export interface RuntimeOperationOptions { readonly signal?: AbortSignal; }
export interface OmrRuntime {
  run(input: string, options?: RuntimeOperationOptions & { readonly images?: readonly ChatImageBlock[] }): Promise<RuntimeResult>;
  command(line: string, options?: RuntimeOperationOptions): Promise<RuntimeResult>;
  snapshot(): Promise<RuntimeSnapshot>;
  /** Committed records from a snapshot of the current trace; seq is local to its continuation file. */
  readEvents(options?: { readonly afterSeq?: number; readonly limit?: number }): Promise<readonly ExecutionEvent[]>;
  /** Non-blocking observations; thrown/rejected listeners are detached and reported by observerErrors. */
  onEvent(listener: (observation: ExecutionObservation) => void): () => void;
  observerErrors(): readonly string[];
  cancel(reason?: unknown): void;
  close(): Promise<void>;
}

/** Embedding entry point: no stdin loop, signal handlers, TUI, process.exit, or implicit target detection. */
export const createRuntime = async (options: RuntimeOptions = {}): Promise<OmrRuntime> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const {env, sources} = options.env ? {env: {...options.env}, sources: []} : resolveReaEnv();
  const opts = parseArgs(["node", "omr", "--json", "--plain"]); opts.target = options.target ? resolve(cwd, options.target) : null; opts.noModel = options.noModel ?? false; opts.model = options.model ?? null;
  const session = await createSession(opts.target, null, {rootDir: options.sessionsRootDir});
  const listeners = new Set<(observation: ExecutionObservation) => void>(); if (options.onEvent) listeners.add(options.onEvent);
  const errors: string[] = []; let detach = (): void => {}; let commandResult: unknown = null;
  const recordError = (error: unknown): void => { errors.push(error instanceof Error ? error.message : String(error)); if (errors.length > 10) errors.shift(); };
  const notify = (observation: ExecutionObservation): void => {
    for (const listener of [...listeners]) {
      try { const result = (listener as (value: ExecutionObservation) => unknown)(observation); if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).catch(error => {listeners.delete(listener);recordError(error);}); }
      catch (error) {listeners.delete(listener);recordError(error);}
    }
  };
  const write = (stream: RuntimeOutput["stream"], text: string): void => {
    if (stream === "stdout") try { const value = JSON.parse(text); if (value.type === "command.result") commandResult = value.payload; } catch { /* ordinary text output */ }
    try {options.onOutput?.({schema: "omr-output/v1", stream, text});} catch (error) {recordError(error);}
  };
  const output = new OutputSink({json: true, writeStdout: text => write("stdout", text), writeStderr: text => write("stderr", text)});
  const ctx = new OmrContext({opts, cwd, env, sources, session, currentTarget: opts.target, currentMagic: null, sessionsRootDir: options.sessionsRootDir, output, deps: {
    createModelClient: options.adapters?.createModelClient, connectRea: options.adapters?.connectRea,
    onExecutionStore: (store: ExecutionStore) => {detach();detach = store.observe(notify);},
  }});
  const registry = createDefaultCommandRegistry(); let queue: Promise<void> = Promise.resolve(), active: AbortController | null = null, closed = false, closing: Promise<void> | null = null;
  const identity = (): RuntimeSession => ({id: ctx.session.id, directory: ctx.session.dir, target: ctx.currentTarget});
  const enqueue = <T>(work: () => Promise<T>, allowClosed = false): Promise<T> => {
    const task = queue.then(async () => {if (closed && !allowClosed) throw new Error("OMR runtime is closed"); return work();}); queue = task.then(() => {}, () => {}); return task;
  };
  const operate = (work: () => Promise<void>, signal?: AbortSignal): Promise<RuntimeResult> => enqueue(async () => {
    active = new AbortController(); const operation = signal ? AbortSignal.any([signal, active.signal]) : active.signal;
    const checkpoint = output.outcomeCheckpoint(); commandResult = null; ctx.lastAssistantText = "";
    try { await ctx.withOperationSignal(operation, work); }
    catch (error) { if (operation.aborted) output.recordOutcome({status: "cancelled", finishReason: null}); else output.fail(error instanceof Error ? error.message : String(error)); }
    finally {active = null;}
    const outcome = operation.aborted ? {status: "cancelled" as const, finishReason: null} : output.outcomeSince(checkpoint);
    return {schema: "omr-runtime/v1", session: identity(), outcome, exitCode: exitCodeFor(outcome.status), text: ctx.lastAssistantText, commandResult};
  });
  const api: OmrRuntime = {
    run: (input, operation = {}) => operate(() => ctx.runTurn(input, input.slice(0,80), operation.images ? {images: operation.images} : {}), operation.signal),
    command: (line, operation = {}) => operate(async () => {if (!line.trim().startsWith("/")) throw new Error("Runtime command must start with /"); const keep = await registry.dispatchSlashLine(ctx, line.trim()); if (!keep) {closed = true;await ctx.shutdown("complete");}}, operation.signal),
    snapshot: () => enqueue(async () => {await ctx.runtime.usage.initialize();await ctx.runtime.investigation.initialize();return {schema: "omr-runtime/v1", session: identity(), task: await ctx.runtime.task.read(), usage: ctx.runtime.usage.snapshot(), origin: ctx.runtime.evidenceOrigin ? structuredClone(ctx.runtime.evidenceOrigin) : null, resources: resources.snapshot(), investigation: ctx.runtime.investigation.read()};}, true),
    readEvents: (request = {}) => enqueue(async () => {const after = request.afterSeq ?? 0, limit = request.limit ?? 100; if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid execution cursor/limit"); await ctx.runtime.events.flush(); const until = ctx.runtime.events.committedSequence; const events: ExecutionEvent[] = []; for await (const event of readExecutionEvents(ctx.runtime.events.path)) {if (event.seq > until) break;if (event.seq > after) events.push(event);if (events.length >= limit) break;} return events;}, true),
    onEvent: listener => {listeners.add(listener);return () => {listeners.delete(listener);};}, observerErrors: () => [...errors, ...ctx.runtime.events.observerErrors()],
    cancel: reason => {active?.abort(reason);ctx.activeAbort?.abort(reason);},
    close: () => {if (closing) return closing;closed = true;active?.abort();ctx.runtime.lifecycle.abort();return closing = queue.then(async () => {try {await ctx.shutdown("complete");await ctx.runtime.close();} finally {detach();listeners.clear();}});},
  };
  try {await ctx.persistMeta();if (options.resume) {const result = await api.command(`/resume ${options.resume}`);if (result.outcome.status !== "completed") throw new Error(`Resume failed (${result.outcome.status})`);}return api;}
  catch (error) {await api.close();throw error;}
};
