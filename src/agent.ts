import { createHash } from "node:crypto";
import { BudgetExceededError } from "./usage.js";
import { LoopGuard } from "./loopGuard.js";
import { contextOverflowOf, estimateRequestTokens, estimateToolTokens, messageImageTokens, resolveModelCapabilities } from "./capabilities.js";
import type { ExecutionOutcome } from "./outcome.js";
import { repairChatHistory, type HistoryRepairReport } from "./history.js";
import type {
  ChatImageBlock,
  ChatMessage,
  ChatToolCall,
  ModelPort,
  NetworkStatusNotice,
  RetryNotice,
  StreamResult,
  ToolDefinition,
  Usage,
} from "./model.js";
import {
  type BrokerOutcome,
  type ReaBroker,
  type ToolSelectionContext,
} from "./broker.js";
import { asRecord } from "./values.js";
import {
  COMPACTION_RECOVERY_BAND,
  DEFAULT_COMPACTION_SETTINGS,
  MAX_SUMMARY_TOKENS,
  SUMMARIZER_SYSTEM,
  estimateTokens,
  extractPreviousSummary,
  findCutPoint,
  handoffContextMessage,
  handoffRequest,
  isSummaryMessage,
  resolveThresholdTokens,
  serializeTranscript,
  shouldCompact,
  snapcompactContextMessage,
  summaryContextMessage,
  summaryRequest,
  updateSummaryRequest,
  type CompactionSettings,
  type CompactionStrategy,
  type ContextUsage,
} from "./compaction.js";
import { buildSnapcompactArchive } from "./snapcompact.js";

export interface AgentEvents {
  /**
   * Called after every completed step whose tool results are all in history (a valid, resumable
   * conversation state), so the caller can persist it and survive a crash mid-turn.
   */
  onCheckpoint?: () => void | Promise<void>;
  /** Called when the step budget is auto-extended because the model is still making progress. */
  onStepBudgetExtended?: (notice: {
    readonly step: number;
    readonly newBudget: number;
    readonly extension: number;
    readonly maxExtensions: number;
  }) => void;
  /** Called when the cumulative session token budget (`OMR_BUDGET_TOKENS` / `/budget`) is reached. */
  onBudgetReached?: (notice: {
    readonly usedTokens: number;
    readonly budgetTokens: number;
    readonly step: number;
  }) => void;
  onAssistantStart?: () => void;
  onReasoningDelta?: (delta: string) => void;
  onAssistantDelta?: (delta: string) => void;
  onAssistantEnd?: (text: string) => void;
  onToolStart?: (
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ) => void;
  /** Live REA progress for a running tool call (e.g. `decompile: running ghidra`). */
  onToolProgress?: (callId: string, message: string) => void;
  onToolEnd?: (callId: string, outcome: BrokerOutcome) => void;
  onStep?: (step: number) => void;
  onUsage?: (turnUsage: Usage, totalTokens: number) => void;
  /** A transient model failure is being retried before any output was shown. */
  onRetry?: (notice: RetryNotice) => void;
  /** Network Guard status (offline pause, active endpoint ping, or restored tick). */
  onNetworkStatus?: (notice: NetworkStatusNotice) => void;
  /** Partial step output was rolled back after a mid-stream network drop before auto-resuming. */
  onStreamReset?: () => void;
  /** A summarizing compaction is about to call the model (can take seconds). */
  onCompactionStart?: (strategy: CompactionStrategy) => void;
  onCompaction?: (report: CompactionReport) => void;
  /** Context usage changed (after a model step or a compaction). */
  onContext?: (usage: ContextUsage) => void;
  /** Real-time and completed-step generation speed (tokens/sec & TTFT). */
  onSpeed?: (telemetry: SpeedTelemetry) => void;
  /** Supervisor steering directives were injected into the active step loop. */
  onSteerApplied?: (
    directives: readonly string[],
    step: number,
    items: readonly QueuedSteerItem[],
  ) => void;
}

export interface SpeedTelemetry {
  readonly tps: number;
  readonly outputTokens: number;
  readonly ttftMs: number | null;
  readonly elapsedMs: number;
  readonly live: boolean;
}

export interface QueuedSteerItem {
  readonly text: string;
  readonly images?: readonly ChatImageBlock[] | undefined;
}

export interface CompactionReport {
  readonly strategy: CompactionStrategy;
  readonly auto: boolean;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  /** Messages folded into the summary (0 for `shake`). */
  readonly summarizedMessages: number;
  readonly durationMs: number;
  /** Why nothing changed, or why a fallback strategy ran. */
  readonly note: string | null;
  readonly shake: CompactionStats | null;
  /** Model identifier that generated the summary (null for `shake` / `snapcompact`). */
  readonly compactionModel?: string | null;
  /** Number of bitmap PNG frames rendered when `strategy === "snapcompact"`. */
  readonly frames?: number;
}

/**
 * The broker surface the agent loop needs. `beginTurn` is optional for lightweight brokers;
 * `isReadOnly` is optional too — a broker that does not declare it never gets concurrent tool calls.
 */
export type AgentBroker = Pick<ReaBroker, "definitions" | "dispatch"> & {
  beginTurn?: (userInput?: string) => void;
  isReadOnly?: (name: string, args: Record<string, unknown>) => boolean;
  catalogVersion?: () => string;
};

export interface AgentTurn extends ExecutionOutcome {
  text: string;
  steps: number;
  toolCalls: number;
  aborted: boolean;
  usage: Usage | null;
}

export interface CompactionStats {
  readonly compactedTools: number;
  readonly droppedTurns: number;
  readonly beforeChars: number;
  readonly afterChars: number;
}

export interface RewindResult {
  readonly removedTurns: number;
  readonly removedMessages: number;
  readonly remainingTurns: number;
  readonly remainingMessages: number;
}

export interface AgentOptions {
  /** Durable canonical history, separate from the model's current compacted projection. */
  historyCheckpoint?: ((messages: readonly ChatMessage[], reason: string) => Promise<void>) | undefined;
  archiveProjection?: ((input: import("./contextArchive.js").ArchiveProjectionInput) => Promise<import("./contextArchive.js").ArchiveProjection>) | undefined;
  trace?: ((type: string, data: Record<string, unknown>) => Promise<void>) | undefined;
  systemPrompt: string | (() => string);
  toolContext?: () => ToolSelectionContext;
  /**
   * Volatile per-turn facts (ledger counters, etc.) appended to the user message
   * instead of the system prompt, so the cached prompt prefix stays stable.
   */
  turnContext?: () => string | null;
  /** Fresh request-only observations; canonical history does not grow with each refresh. */
  beforeStep?: ((signal?: AbortSignal) => Promise<void>) | undefined;
  stepContext?: (() => string | null) | undefined;
  reviewCompletion?: (() => {accepted: boolean; message: string} | Promise<{accepted: boolean; message: string}>) | undefined;
  /** Monotonic count of newly committed Evidence, verified Unknowns or passing fixture versions. */
  progressEpoch?: () => number;
  /** Live compaction settings (a getter so `/compaction` can change them mid-session). */
  compaction?: () => CompactionSettings;
  /**
   * Optional dedicated compaction model client (`omp`-style secondary AI for summarization).
   * When set, `soft` / `remote` / `handoff` use this client to summarize and then resume
   * the session with the primary active `this.model`.
   */
  compactionModel?: () => ModelPort | null;
  maxSteps?: number;
  /** Extra `maxSteps` blocks granted on new measured facts (0 / unset disables). */
  autoExtendSteps?: number;
  /** Optional cumulative session token budget cap (number or live getter); `null` / `0` means unlimited. */
  budgetTokens?: (() => number | null) | number | null;
}

const COMPACT_MARKER = "[omr:compacted]";
const ACTIVE_STEP_CHAR_BUDGET = 96_000;
const MAX_RETAINED_TURNS = 400;
/** Tool results that carry playbooks the model would only re-fetch; shake never stubs them. */
const PROTECTED_TOOLS: ReadonlySet<string> = new Set([
  "rea_guide",
  "rea_prompt",
]);
const AUTO_TOOL_MIN_CHARS = 2_200;
const MANUAL_TOOL_MIN_CHARS = 1_200;
const HEAD_PREVIEW_CHARS = 900;

const EVIDENCE_GLOBAL_RE = /\bev_[0-9a-f]{64}\b/g;
const UNKNOWN_GLOBAL_RE = /\bunk_[A-Za-z0-9_-]{6,64}\b/g;

const isAbort = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "AbortError" || error.name === "TimeoutError");

const addNullable = (a: number | null, b: number | null): number | null =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0);

const mergeUsage = (acc: Usage | null, step: Usage | null): Usage | null => {
  if (!step) return acc;
  if (!acc) return { ...step };
  const merged: Usage = {
    prompt_tokens: addNullable(acc.prompt_tokens, step.prompt_tokens),
    completion_tokens: addNullable(
      acc.completion_tokens,
      step.completion_tokens,
    ),
    total_tokens: addNullable(acc.total_tokens, step.total_tokens),
  };
  const cached = addNullable(
    acc.cached_tokens ?? null,
    step.cached_tokens ?? null,
  );
  if (cached !== null) merged.cached_tokens = cached;
  return merged;
};

const messageChars = (msg: ChatMessage): number => {
  let len = msg.content ? msg.content.length : 0;
  len += messageImageTokens(msg) * 4;
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      len += tc.function.name.length + tc.function.arguments.length + 24;
    }
  }
  if (msg.reasoning_content) len += msg.reasoning_content.length;
  if (msg.thinking_blocks) {
    for (const block of msg.thinking_blocks) {
      len +=
        block.type === "thinking"
          ? block.thinking.length + block.signature.length
          : block.data.length;
    }
  }
  return len;
};

/**
 * Compact an oversized `role="tool"` output into an Evidence-preserving stub.
 * Keeps all full 64-hex `ev_...` and `unk_...` identifiers intact so provenance
 * citations, `retained-evidence` inputs, and `get_evidence_bundle` lookups never break.
 */
export const compactToolOutput = (raw: string): string => {
  if (raw.startsWith(COMPACT_MARKER)) return raw;

  const evSet = new Set<string>();
  for (const match of raw.matchAll(EVIDENCE_GLOBAL_RE)) {
    evSet.add(match[0]);
    if (evSet.size >= 24) break;
  }

  const unkSet = new Set<string>();
  for (const match of raw.matchAll(UNKNOWN_GLOBAL_RE)) {
    unkSet.add(match[0]);
    if (unkSet.size >= 16) break;
  }

  const preview = raw.slice(0, HEAD_PREVIEW_CHARS).trimEnd();
  const evLine = evSet.size > 0 ? [...evSet].join(", ") : "none";
  const unkPart =
    unkSet.size > 0 ? `\nunknown_ids: ${[...unkSet].join(", ")}` : "";

  return (
    `${COMPACT_MARKER} (${raw.length} chars -> stub; full record retained in REA session)\n` +
    `evidence_ids: ${evLine}${unkPart}\n` +
    `head_preview:\n${preview}\n` +
    `… [Cite exact evidence_id above, pass { kind: "retained-evidence", evidence_id } where supported, or call get_evidence_bundle { detail: "records", filters: { evidence_id: "<id>" } } if omitted detail is required.]`
  );
};

/** Settle immediately when `signal` aborts, even if the underlying work ignores the signal. */
const abortable = <T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) { onAbort(); work.catch(() => {}); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
};

/** Hard bound on consecutive in-turn recoveries (empty/truncated tool turns) before the turn is reported partial. */
const MAX_TURN_RECOVERIES = 3;
/** Consecutive provider context-overflow recoveries (reset by any successful model response). */
const MAX_CONTEXT_RECOVERIES = 6;
const TRIM_NOTE = /^\[omr\] (\d+) older tool-exchange messages were dropped/;

/**
 * OpenAI-compatible providers disagree on finish_reason spelling and some omit it when `[DONE]` follows a
 * tool call. A turn that carries tool calls is a tool turn unless the provider said it was cut off.
 */
export const normalizeFinishReason = (raw: string | null, toolCallCount: number, hasContent = false): string | null => {
  const reason = raw?.trim().toLowerCase() ?? null;
  if (reason === "function_call" || reason === "tool_call" || reason === "tool_use" || reason === "tool-calls") return "tool_calls";
  if (reason === "end_turn" || reason === "stop_sequence" || reason === "eos") return "stop";
  // Providers that omit finish_reason after `[DONE]`: tool calls mean a tool turn, plain text means a final answer.
  if (!reason) return toolCallCount > 0 ? "tool_calls" : hasContent ? "stop" : raw;
  return reason;
};

export class Agent {
  private readonly messages: ChatMessage[];
  private model: ModelPort;
  private broker: AgentBroker;
  private cumulativeTokens = 0;
  private toolSchemaTokens = 0;
  private observedContextWindow: number | null = null;
  /** Provider-reported context size after the latest model step, and the history length it covers. */
  private lastUsage: { tokens: number; count: number } | null = null;
  private stepContextTokens = 0;
  /** After an ineffective compaction, skip auto-compaction until usage grows past this. */
  private autoBlockedBelow = 0;
  private readonly steerQueue: QueuedSteerItem[] = [];
  private readonly progressEvidence = new Set<string>();

  constructor(
    model: ModelPort,
    broker: AgentBroker,
    private readonly options: AgentOptions,
  ) {
    this.model = model;
    this.broker = broker;
    this.messages = [{ role: "system", content: this.resolveSystemPrompt() }];
  }

  private resolveSystemPrompt(): string {
    return typeof this.options.systemPrompt === "function"
      ? this.options.systemPrompt()
      : this.options.systemPrompt;
  }

  private resolveToolContext(): ToolSelectionContext | undefined {
    return this.options.toolContext?.();
  }

  get history(): readonly ChatMessage[] {
    return this.messages;
  }

  get modelId(): string {
    return this.model.model;
  }

  get totalTokens(): number {
    return this.model.sessionUsage?.totalTokens ?? this.cumulativeTokens;
  }

  get ownTokens(): number { return this.model.sessionUsage?.scopeTokens ?? this.cumulativeTokens; }

  historyChars(): number {
    let total = 0;
    for (const msg of this.messages) total += messageChars(msg);
    return total;
  }

  private settings(): CompactionSettings {
    const supplied = this.options.compaction?.();
    const settings = supplied ?? DEFAULT_COMPACTION_SETTINGS;
    const capabilities = this.model.capabilities ?? resolveModelCapabilities(this.model.model, this.model.providerId);
    const operator = settings.windowSource === "operator" || Boolean(supplied && settings.windowSource === undefined);
    const window = Math.max(1, Math.min(operator ? settings.contextWindow : capabilities.contextWindow, this.observedContextWindow ?? Infinity));
    // No source knows this model's window: the 32k placeholder is not a fact, so it must neither
    // trigger proactive compaction nor block a request. A provider overflow error teaches the real limit.
    const unknown = !operator && capabilities.source === "conservative-default" && this.observedContextWindow === null;
    const reserve = this.model.outputReserveTokens ?? Math.min(4096, Math.floor(window / 4));
    return {...settings, contextWindow: window, windowSource: operator ? "operator" : unknown ? "unknown" : "model", keepRecentTokens: Math.min(settings.keepRecentTokens, Math.floor(window / 2)), outputReserveTokens: Math.max(0, Math.min(window - 1, reserve))};
  }

  /** Current context size against the configured window (provider usage, floored by a local estimate). */
  contextUsage(): ContextUsage {
    const settings = this.settings();
    try { this.toolSchemaTokens = (this.model.capabilities ?? resolveModelCapabilities(this.model.model,this.model.providerId)).tools === false ? 0 : estimateToolTokens(this.broker.definitions(this.resolveToolContext())); }
    catch { /* A catalog refresh can temporarily withhold schemas; the last admitted estimate remains visible. */ }
    const estimate = estimateTokens(this.historyChars()) + this.toolSchemaTokens + this.stepContextTokens;
    let tokens = estimate;
    let source: ContextUsage["source"] = "estimate";
    if (this.lastUsage && this.lastUsage.count <= this.messages.length) {
      let after = 0;
      for (let i = this.lastUsage.count; i < this.messages.length; i += 1)
        after += messageChars(this.messages[i]!);
      const reported = this.lastUsage.tokens + estimateTokens(after);
      if (reported >= estimate) {
        tokens = reported;
        source = "provider";
      }
    }
    return {
      tokens,
      window: settings.contextWindow,
      percent: Math.min(
        999,
        Math.round((tokens / settings.contextWindow) * 1000) / 10,
      ),
      thresholdTokens: resolveThresholdTokens(settings),
      source,
      outputReserveTokens: settings.outputReserveTokens ?? 0,
      windowSource: this.observedContextWindow ? "provider-error" : settings.windowSource === "operator" ? "operator" : (this.model.capabilities ?? resolveModelCapabilities(this.model.model, this.model.providerId)).source,
    };
  }

  setModel(model: ModelPort): void {
    if (this.model !== model) this.observedContextWindow = null;
    this.model = model;
  }

  /** Rebind to a replacement broker after the REA child was restarted. */
  setBroker(broker: AgentBroker): void {
    this.broker = broker;
  }

  /**
   * Queue a mid-flight course-correction directive from the parent agent or operator.
   * Applied at the next clean step boundary (after all active `tool_calls` have received their `role="tool"` results).
   */
  enqueueSteer(
    instruction: string,
    images?: readonly ChatImageBlock[],
  ): void {
    const clean = instruction.trim();
    const hasImages = Boolean(images && images.length > 0);
    if (clean || hasImages) {
      this.steerQueue.push({
        text: clean || "(attached image)",
        ...(hasImages ? { images } : {}),
      });
    }
  }

  pendingSteerCount(): number {
    return this.steerQueue.length;
  }

  pendingSteers(): readonly QueuedSteerItem[] {
    return this.steerQueue;
  }

  dequeueLastSteer(): QueuedSteerItem | null {
    return this.steerQueue.pop() ?? null;
  }

  drainSteerQueue(): QueuedSteerItem[] {
    return this.steerQueue.splice(0, this.steerQueue.length);
  }

  clear(): void {
    this.lastUsage = null;
    this.autoBlockedBelow = 0;
    this.steerQueue.length = 0;
    this.messages.splice(1);
    this.messages[0] = { role: "system", content: this.resolveSystemPrompt() };
  }

  /**
   * Roll back the most recent `turns` user-initiated conversation turns (`role === "user"` boundaries)
   * without breaking `assistant.tool_calls` ↔ `role="tool"` pairing or earlier Evidence citations.
   */
  rewind(turns = 1): RewindResult {
    const requested = Math.max(0, Math.trunc(turns));
    const userStarts: number[] = [];
    for (let i = 1; i < this.messages.length; i += 1) {
      if (this.messages[i]!.role === "user") userStarts.push(i);
    }
    if (requested === 0 || userStarts.length === 0) {
      return {
        removedTurns: 0,
        removedMessages: 0,
        remainingTurns: userStarts.length,
        remainingMessages: Math.max(0, this.messages.length - 1),
      };
    }
    const count = Math.min(requested, userStarts.length);
    const cutIndex = userStarts[userStarts.length - count]!;
    const removedMessages = this.messages.length - cutIndex;
    this.messages.splice(cutIndex);
    this.lastUsage = null;
    this.autoBlockedBelow = 0;
    this.messages[0] = { role: "system", content: this.resolveSystemPrompt() };
    return {
      removedTurns: count,
      removedMessages,
      remainingTurns: userStarts.length - count,
      remainingMessages: Math.max(0, this.messages.length - 1),
    };
  }

  /**
   * Restore non-system conversation messages from a saved session.
   *
   * The file is an external boundary, so the OpenAI/Anthropic pairing invariant is re-established here:
   * an assistant message whose `tool_calls` are not all answered by directly following `tool` messages
   * is dropped together with its partial results, and a `tool` message with no owning call is dropped.
   */
  restoreHistory(savedMessages: readonly unknown[]): HistoryRepairReport {
    this.lastUsage = null;
    this.autoBlockedBelow = 0;
    const repaired = repairChatHistory(savedMessages);
    for (const message of repaired.messages) if (message.role === "tool") for (const match of (message.content ?? "").matchAll(/\bev_[a-f0-9]{64}\b/g)) this.progressEvidence.add(match[0]);
    this.messages.splice(
      0,
      this.messages.length,
      { role: "system", content: this.resolveSystemPrompt() },
      ...repaired.messages,
    );
    return repaired.report;
  }

  /**
   * Compact older verbose tool payloads while strictly preserving `tool_call_id`
   * pairing and full `ev_...` provenance identifiers.
   */
  compact(options?: {
    force?: boolean;
    protectRecentTools?: number;
    targetBudget?: number;
    /** Also keep every message within the newest N tokens verbatim. */
    protectTailTokens?: number;
  }): CompactionStats {
    const force = options?.force ?? true;
    const protectRecent = options?.protectRecentTools ?? (force ? 1 : 3);
    const budget =
      options?.targetBudget ?? (force ? 0 : ACTIVE_STEP_CHAR_BUDGET);
    const minToolChars = force ? MANUAL_TOOL_MIN_CHARS : AUTO_TOOL_MIN_CHARS;

    const beforeChars = this.historyChars();
    let currentChars = beforeChars;
    let compactedTools = 0;
    let droppedTurns = 0;

    if (force || currentChars > budget) {
      let tailStart = this.messages.length;
      if (options?.protectTailTokens) {
        let tail = 0;
        for (let i = this.messages.length - 1; i >= 1; i -= 1) {
          tail += estimateTokens(messageChars(this.messages[i]!));
          tailStart = i;
          if (tail >= options.protectTailTokens) break;
        }
      }
      const toolNames = new Map<string, string>();
      for (const m of this.messages)
        for (const call of m.tool_calls ?? [])
          toolNames.set(call.id, call.function.name);
      const toolIndices: number[] = [];
      for (let i = 1; i < this.messages.length; i += 1) {
        const m = this.messages[i]!;
        if (m.role !== "tool" || i >= tailStart) continue;
        if (
          PROTECTED_TOOLS.has(
            (m.tool_call_id && toolNames.get(m.tool_call_id)) || "",
          )
        )
          continue;
        toolIndices.push(i);
      }
      const eligibleEnd = Math.max(0, toolIndices.length - protectRecent);
      for (let t = 0; t < eligibleEnd; t += 1) {
        if (!force && currentChars <= budget) break;
        const idx = toolIndices[t]!;
        const msg = this.messages[idx]!;
        const content = msg.content ?? "";
        if (content.length < minToolChars || content.startsWith(COMPACT_MARKER))
          continue;
        const stub = compactToolOutput(content);
        if (stub.length < content.length) {
          msg.content = stub;
          currentChars -= content.length - stub.length;
          compactedTools += 1;
        }
      }
    }

    // Enforce marathon-session ceiling at clean `role === "user"` boundaries so no
    // `assistant.tool_calls` <-> `role="tool"` pair is ever split.
    const findUserTurnStarts = (): number[] => {
      const starts: number[] = [];
      for (let i = 1; i < this.messages.length; i += 1) {
        if (this.messages[i]!.role === "user") starts.push(i);
      }
      return starts;
    };

    // Emergency ceiling only: the configured strategy normally compacts long before this.
    const hardCapChars = Math.floor(this.settings().contextWindow * 4 * 0.97);
    let userStarts = findUserTurnStarts();
    while (
      userStarts.length > 2 &&
      (userStarts.length > MAX_RETAINED_TURNS || currentChars > hardCapChars)
    ) {
      const firstUser = userStarts[0]!;
      const secondUser = userStarts[1]!;
      let removedChars = 0;
      for (let i = firstUser; i < secondUser; i += 1) {
        removedChars += messageChars(this.messages[i]!);
      }
      this.messages.splice(firstUser, secondUser - firstUser);
      currentChars -= removedChars;
      droppedTurns += 1;
      userStarts = findUserTurnStarts();
    }

    return {
      compactedTools,
      droppedTurns,
      beforeChars,
      afterChars: this.historyChars(),
    };
  }

  /**
   * Last-resort context relief for a single very long turn: drop the oldest complete assistant/tool
   * exchanges (never splitting a tool_call from its results, never touching user messages, always keeping
   * the newest exchange) until the request fits the window. Returns how many messages were dropped.
   */
  private trimToWindow(): number {
    const fits = (): boolean => {
      const usage = this.contextUsage();
      return usage.tokens + (usage.outputReserveTokens ?? 0) <= usage.window;
    };
    // Earlier notes are folded into one so repeated trimming never accumulates note messages.
    let carried = 0;
    const isNote = (m: ChatMessage): boolean => m.role === "user" && typeof m.content === "string" && TRIM_NOTE.test(m.content);
    const prune = (): void => {
      for (let i = this.messages.length - 1; i >= 1; i -= 1) {
        const m = this.messages[i]!;
        if (isNote(m)) { carried += Number(TRIM_NOTE.exec(m.content as string)![1]); this.messages.splice(i, 1); }
      }
    };
    let dropped = 0;
    let firstDropAt = -1;
    if (fits()) return 0;
    prune();
    while (!fits()) {
      const groupStarts: number[] = [];
      for (let i = 1; i < this.messages.length; i += 1) if (this.messages[i]!.role === "assistant") groupStarts.push(i);
      if (groupStarts.length < 2) break;
      const start = groupStarts[0]!;
      let end = start + 1;
      while (end < this.messages.length && this.messages[end]!.role === "tool") end += 1;
      this.messages.splice(start, end - start);
      dropped += end - start;
      if (firstDropAt < 0) firstDropAt = start;
      this.lastUsage = null;
    }
    if (dropped > 0 || carried > 0) {
      const total = dropped + carried;
      this.messages.splice(firstDropAt < 0 ? 1 : firstDropAt, 0, {
        role: "user",
        content: `[omr] ${total} older tool-exchange messages were dropped to keep this long turn inside the model context window. Evidence (ev_ ids) and Unknowns remain in the session ledger; re-query anything you still need.`,
      });
    }
    return dropped;
  }

  private async autoCompact(
    events: AgentEvents,
    signal: AbortSignal | undefined,
    turnStart: number | null,
  ): Promise<boolean> {
    const settings = this.settings();
    const usage = this.contextUsage();
    if (
      !shouldCompact(usage.tokens, settings) ||
      usage.tokens < this.autoBlockedBelow
    )
      return false;
    if (settings.strategy !== "shake")
      events.onCompactionStart?.(settings.strategy);
    const report = await this.compactWith(
      settings.strategy,
      "",
      signal,
      true,
      turnStart,
    );
    events.onCompaction?.(report);
    events.onContext?.(this.contextUsage());
    const recovered =
      report.afterTokens <=
      resolveThresholdTokens(settings) * COMPACTION_RECOVERY_BAND;
    // An ineffective pass must not retrigger (and re-bill a summary) on every following step.
    this.autoBlockedBelow = recovered
      ? 0
      : report.afterTokens + Math.floor(settings.contextWindow * 0.05);
    return report.afterTokens < report.beforeTokens;
  }

  /**
   * Compact history with the chosen strategy:
   * - `soft` / `context-full`: local LLM summary (using `compactionModel` or active model), keeping a verbatim tail.
   * - `remote`: tries OpenAI-compatible server compaction (`/responses/compact`), then falls back to local `soft` summary.
   * - `snapcompact`: archives history onto dense 8x13 bitmap PNG frames + plain-text `ev_`/`unk_` ledger (no LLM call).
   * - `handoff`: replaces the entire context with a self-contained handoff document.
   * - `shake`: stubs oversized tool outputs without a model call.
   * `turnStart` is the index of the active turn's user message when compacting mid-turn.
   */
  async compactWith(
    strategy: CompactionStrategy,
    focus: string,
    signal?: AbortSignal,
    auto = false,
    turnStart: number | null = null,
    modelOverride?: ModelPort | null,
  ): Promise<CompactionReport> {
    await this.options.historyCheckpoint?.(this.history, "pre-compaction");
    const settings = this.settings();
    const started = Date.now();
    const beforeTokens = this.contextUsage().tokens;
    const finish = async (
      used: CompactionStrategy,
      summarizedMessages: number,
      note: string | null,
      shake: CompactionStats | null,
      compactionModel: string | null = null,
      frames?: number,
    ): Promise<CompactionReport> => {
      this.lastUsage = null;
      await this.options.historyCheckpoint?.(this.history, "compaction");
      return {
        strategy: used,
        auto,
        beforeTokens,
        afterTokens: this.contextUsage().tokens,
        summarizedMessages,
        durationMs: Date.now() - started,
        note,
        shake,
        compactionModel,
        ...(frames !== undefined ? { frames } : {}),
      };
    };
    const shake = (note: string | null): Promise<CompactionReport> => {
      const stats = auto
        ? this.compact({
            force: false,
            protectRecentTools: 3,
            protectTailTokens: settings.keepRecentTokens,
            targetBudget: Math.floor(
              resolveThresholdTokens(settings) * COMPACTION_RECOVERY_BAND * 4,
            ),
          })
        : this.compact({
            force: true,
            protectRecentTools: 1,
            protectTailTokens: settings.keepRecentTokens,
          });
      return finish("shake", 0, note, stats, null);
    };

    if (strategy === "shake" || strategy === "off")
      return shake(strategy === "off" ? "strategy off; ran shake" : null);

    const cut =
      strategy === "handoff"
        ? { cut: this.messages.length }
        : findCutPoint(this.messages, settings.keepRecentTokens, messageChars);
    if (!cut || cut.cut <= 1 || this.messages.length <= 2) {
      return finish(
        strategy,
        0,
        "nothing to summarize yet (history is within the recent window)",
        null,
        null,
      );
    }
    const head = this.messages.slice(1, cut.cut);
    const previous =
      strategy !== "handoff" && head[0]
        ? extractPreviousSummary(head[0])
        : null;

    // The active request is either still a plain user message, or already folded into an earlier summary.
    const carried =
      head[0] && isSummaryMessage(head[0])
        ? (/Current operator request \(continue working on it\):\n([\s\S]*)$/.exec(
            head[0].content ?? "",
          )?.[1] ?? null)
        : null;
    const activeInput =
      turnStart !== null && turnStart >= 1 && turnStart < cut.cut
        ? (this.messages[turnStart]?.content ?? carried)
        : carried;

    if (strategy === "snapcompact") {
      const previousImages = previous ? (head[0]?.images ?? []) : [];
      const archive = buildSnapcompactArchive(previous ? head.slice(1) : head, {
        providerId: this.model.providerId ?? null,
        modelId: this.model.model,
        previousSummary: previous,
      });
      const imageHashes = new Set<string>();
      const retainedImages = [...previousImages, ...archive.images].filter((image) => {
        const hash = createHash("sha256").update(image.mimeType).update(image.data).digest("hex");
        if (imageHashes.has(hash)) return false;
        imageHashes.add(hash); return true;
      });
      const projection = await this.options.archiveProjection?.({messages: head, images: retainedImages, imageTokens: archive.imageTokens + (previous && head[0] ? messageImageTokens(head[0]) : 0), summary: archive.summaryText, activeImageBudget: Math.min(8500, Math.floor(settings.contextWindow * 0.15))});
      const activeImages = projection?.images ?? retainedImages;
      const wrapper = snapcompactContextMessage(projection?.summary ?? archive.summaryText) + (projection ? `\n\n${projection.note}` : previousImages.length ? `\n\nEarlier archive frames are attached first (${previousImages.length}); new frames follow (${archive.images.length}). Earlier frames remain part of the conversation archive.` : "");
      const summaryMessage: ChatMessage = {
        role: "user",
        content: activeInput
          ? `${wrapper}\n\nCurrent operator request (continue working on it):\n${activeInput}`
          : wrapper,
        ...(activeImages.length > 0
          ? { images: activeImages, image_tokens: projection?.imageTokens ?? archive.imageTokens + (previous && head[0] ? messageImageTokens(head[0]) : 0) }
          : {}),
      };
      const tail = this.messages.slice(cut.cut);
      this.messages.splice(
        0,
        this.messages.length,
        this.messages[0]!,
        summaryMessage,
        ...tail,
      );
      const frameNote = `${archive.frameCount} new bitmap frame${archive.frameCount === 1 ? "" : "s"} (${archive.shape.name}); retained ${previousImages.length} earlier frame(s)`;
      return finish(
        "snapcompact",
        head.length,
        frameNote,
        null,
        null,
        activeImages.length,
      );
    }

    const summarizer =
      modelOverride ?? this.options.compactionModel?.() ?? this.model;
    const summarizerTag =
      summarizer.providerId && summarizer.providerId !== "custom"
        ? `${summarizer.providerId}:${summarizer.model}`
        : summarizer.model;

    const transcript = serializeTranscript(previous ? head.slice(1) : head);
    const request =
      strategy === "handoff"
        ? handoffRequest(focus)
        : previous
          ? updateSummaryRequest(focus)
          : summaryRequest(focus);
    const user = `<conversation>\n${transcript}\n</conversation>\n\n${
      previous ? `<previous-summary>\n${previous}\n</previous-summary>\n\n` : ""
    }${request}`;

    let summary: string;
    let completionNote: string | null = null;
    let usedStrategy: CompactionStrategy = strategy;
    if (strategy === "remote") {
      try {
        if (typeof summarizer.compactRemote === "function") {
          summary = await summarizer.compactRemote(
            SUMMARIZER_SYSTEM,
            user,
            MAX_SUMMARY_TOKENS,
            signal,
            settings.remoteEndpoint,
          );
        } else {
          throw new Error("remote compaction unsupported by client");
        }
      } catch (remoteError) {
        if (isAbort(remoteError) || signal?.aborted) throw remoteError;
        // Remote server compaction unavailable -> fall back to local `soft` summary (omp behavior).
        try {
          summary = await summarizer.summarize(
            SUMMARIZER_SYSTEM,
            user,
            MAX_SUMMARY_TOKENS,
            signal,
          );
          usedStrategy = "soft";
          completionNote =
            `remote server compaction unavailable; summarized locally (soft). Reason: ${remoteError instanceof Error ? remoteError.message : String(remoteError)}`;
        } catch (localError) {
          if (isAbort(localError) || signal?.aborted) throw localError;
          const reason =
            localError instanceof Error
              ? localError.message
              : String(localError);
          return shake(
            `remote+soft summary failed (${reason}); ran shake instead`,
          );
        }
      }
    } else {
      try {
        summary = await summarizer.summarize(
          SUMMARIZER_SYSTEM,
          user,
          MAX_SUMMARY_TOKENS,
          signal,
        );
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        return shake(
          `${strategy} summary failed (${reason}); ran shake instead`,
        );
      }
    }

    const wrapper =
      strategy === "handoff"
        ? handoffContextMessage(summary)
        : summaryContextMessage(summary);
    const summaryMessage: ChatMessage = {
      role: "user",
      content: activeInput
        ? `${wrapper}\n\nCurrent operator request (continue working on it):\n${activeInput}`
        : wrapper,
    };
    const tail = this.messages.slice(cut.cut);
    this.messages.splice(
      0,
      this.messages.length,
      this.messages[0]!,
      summaryMessage,
      ...tail,
    );
    return finish(
      usedStrategy,
      head.length,
      completionNote,
      null,
      summarizerTag,
    );
  }

  async run(
    input: string,
    events: AgentEvents = {},
    signal?: AbortSignal,
    images?: readonly ChatImageBlock[],
  ): Promise<AgentTurn> {
    // Refresh dynamic system prompt and trim completed prior-turn bulk before appending new user prompt.
    this.messages[0] = { role: "system", content: this.resolveSystemPrompt() };
    // `reasoning_content` is only echoed inside the active tool loop; drop it from finished turns.
    for (const msg of this.messages) {
      if (msg.reasoning_content !== undefined) delete msg.reasoning_content;
    }
    this.broker.beginTurn?.(input);

    const initialHistoryLength = this.messages.length;
    // Set once a compaction rewrites history, after which `initialHistoryLength` is no longer a valid index.
    let compacted = false;
    const pristine = (): boolean =>
      !compacted && this.messages.length === initialHistoryLength + 1;
    const turnNote = this.options.turnContext?.();
    this.messages.push({
      role: "user",
      content: turnNote ? `${input}\n\n${turnNote}` : input,
      ...(images && images.length > 0 ? { images } : {}),
    });

    let latestText = "";
    let richestText = "";
    let turnUsage: Usage | null = null;
    let totalToolCalls = 0;
    let completionReviews = 0;
    const loopGuard = new LoopGuard();
    // Unlimited unless the operator opted in (OMR_MAX_STEPS > 0): a turn ends on a final answer, an abort,
    // or an unrecoverable error, never because a counter ran out.
    const maxSteps = this.options.maxSteps !== undefined && this.options.maxSteps > 0 ? this.options.maxSteps : Number.POSITIVE_INFINITY;
    const maxExtensions = Number.isFinite(maxSteps) ? Math.max(
      0,
      Math.trunc(this.options.autoExtendSteps ?? 0),
    ) : 0;
    let stepBudget = maxSteps;
    let extensionsUsed = 0;
    let finishReason: string | null = null;
    let contextRecoveries = 0;
    let turnRecoveries = 0;
    const flushPendingSteers = (step: number): boolean => {
      if (this.steerQueue.length === 0) return false;
      const items = this.steerQueue.splice(0, this.steerQueue.length);
      const directives = items.map((item) => item.text);
      const steerImages: ChatImageBlock[] = [];
      for (const item of items) {
        if (item.images) steerImages.push(...item.images);
      }
      const joined = directives
        .map((d, idx) => `${idx + 1}. ${d}`)
        .join("\n");
      this.messages.push({
        role: "user",
        content: `[SUPERVISOR COURSE-CORRECTION / STEERING DIRECTIVE]:\n${joined}\n\nAdjust your investigation immediately to follow this directive, correct any mistaken assumption, and continue with Evidence-backed REA tool calls.`,
        ...(steerImages.length > 0 ? { images: steerImages } : {}),
      });
      loopGuard.clear();
      events.onSteerApplied?.(directives, step, items);
      return true;
    };

    for (let step = 1; step <= stepBudget; step += 1) {
      let stepMadeProgress = false;
      let stepToolSucceeded = false;
      const progressBefore = this.options.progressEpoch?.();
      if (signal?.aborted) {
        if (pristine()) this.messages.splice(initialHistoryLength);
        return {
          text: latestText || richestText,
          steps: step - 1,
          toolCalls: totalToolCalls,
          aborted: true,
          status: "cancelled", finishReason,
          usage: turnUsage,
        };
      }

      const rawBudget =
        typeof this.options.budgetTokens === "function"
          ? this.options.budgetTokens()
          : (this.options.budgetTokens ?? null);
      if (
        rawBudget !== null &&
        rawBudget > 0 &&
        this.totalTokens >= rawBudget
      ) {
        if (pristine()) this.messages.splice(initialHistoryLength);
        events.onBudgetReached?.({
          usedTokens: this.totalTokens,
          budgetTokens: rawBudget,
          step,
        });
        const base = richestText || latestText;
        return {
          text: `${base}\n\n[omr] session token budget reached (${this.totalTokens} / ${rawBudget} tokens). Session is checkpointed; raise the cap with \`/budget <tokens>\` or disable with \`/budget off\` to continue.`.trim(),
          steps: step - 1,
          toolCalls: totalToolCalls,
          aborted: false,
          status: "budget_exhausted", finishReason,
          usage: turnUsage,
        };
      }

      try {await this.options.beforeStep?.(signal);}
      catch (error) {if (isAbort(error) || signal?.aborted) return {text: latestText || richestText, steps: step - 1, toolCalls: totalToolCalls, aborted: true, status: "cancelled", finishReason, usage: turnUsage};throw error;}
      const stepNote = this.options.stepContext?.();
      const stepMessages: ChatMessage[] = stepNote ? [{role: "user", content: stepNote}] : [];
      this.stepContextTokens = stepMessages.length ? estimateRequestTokens(stepMessages) : 0;
      const capabilities = this.model.capabilities ?? resolveModelCapabilities(this.model.model, this.model.providerId);
      const tools: ToolDefinition[] = capabilities.tools === false ? [] : this.broker.definitions(this.resolveToolContext());
      const catalogVersion = this.broker.catalogVersion?.();
      this.toolSchemaTokens = estimateToolTokens(tools);

      // Token-threshold compaction runs before the step that would overflow, including mid-turn.
      try {
        await this.options.historyCheckpoint?.(this.history, "step-input");
        if (
          await this.autoCompact(
            events,
            signal,
            compacted ? null : initialHistoryLength,
          )
        )
          compacted = true;
      } catch (error) {
        if (isAbort(error) || signal?.aborted) {
          if (pristine()) this.messages.splice(initialHistoryLength);
          return {
            text: latestText || richestText,
            steps: step - 1,
            toolCalls: totalToolCalls,
            aborted: true,
            status: "cancelled", finishReason,
            usage: turnUsage,
          };
        }
        throw error;
      }

      // Re-select route tools per step (cached in O(1) by ReaBroker) so opening a target mid-turn
      // immediately exposes format-specific direct tools on the next step.
      const context = this.contextUsage();
      if (this.settings().windowSource !== "unknown" && context.tokens + (context.outputReserveTokens ?? 0) > context.window) {
        // Compaction could not make room. Shed the oldest complete tool exchanges rather than ending a
        // long turn; only an unshrinkable request (system prompt + user messages alone) is unrecoverable.
        const dropped = this.trimToWindow();
        if (dropped > 0) await this.options.trace?.("context.emergency-trim", {step, dropped});
      }
      const fitted = this.contextUsage();
      if (this.settings().windowSource !== "unknown" && fitted.tokens + (fitted.outputReserveTokens ?? 0) > fitted.window) {
        return {text: "[omr] context and output reserve exceed the active model window; shorten the active input or use /compaction before continuing.", steps: step - 1, toolCalls: totalToolCalls, aborted: false, status: "partial", finishReason: "context_window", usage: turnUsage};
      }

      events.onStep?.(step);
      events.onAssistantStart?.();
      let streamed: {
        content: string;
        toolCalls: ChatToolCall[];
        reasoningContent: string | null;
        thinkingBlocks: StreamResult["thinkingBlocks"];
      };
      let partialDelta = "";
      const stepStartedAt = Date.now();
      let firstTokenAt: number | null = null;
      let streamedChars = 0;
      let lastSpeedEmitAt = 0;
      const emitLiveSpeed = (deltaLen: number): void => {
        if (deltaLen <= 0) return;
        const now = Date.now();
        if (firstTokenAt === null) firstTokenAt = now;
        streamedChars += deltaLen;
        if (events.onSpeed && now - lastSpeedEmitAt >= 120) {
          lastSpeedEmitAt = now;
          const genSec = Math.max(0.05, (now - firstTokenAt) / 1000);
          const estTokens = Math.max(1, Math.round(streamedChars / 3.8));
          events.onSpeed({
            tps: Number((estTokens / genSec).toFixed(1)),
            outputTokens: estTokens,
            ttftMs: Math.max(0, firstTokenAt - stepStartedAt),
            elapsedMs: Math.max(1, now - stepStartedAt),
            live: true,
          });
        }
      };
      try {
        // Keep the operator as the latest user request and preserve assistant/tool adjacency.
        // Runtime facts are a separate, request-only message immediately before that request.
        const userIndex = this.messages.findLastIndex(message => message.role === "user");
        const requestMessages = stepMessages.length ? [...this.messages.slice(0,userIndex),...stepMessages,...this.messages.slice(userIndex)] : this.messages;
        await this.options.trace?.("model.request", {model: this.model.model, provider: this.model.providerId ?? null, step, messages: requestMessages.length, tools: tools.length, ephemeralContext: stepMessages.length > 0});
        const result = await this.model.stream(
          requestMessages,
          tools,
          signal,
          (delta) => {
            partialDelta += delta;
            emitLiveSpeed(delta.length);
            events.onAssistantDelta?.(delta);
          },
          (thought) => {
            emitLiveSpeed(thought.length);
            events.onReasoningDelta?.(thought);
          },
          (notice) => events.onRetry?.(notice),
          (netNotice) => events.onNetworkStatus?.(netNotice),
          () => {
            partialDelta = "";
            firstTokenAt = null;
            streamedChars = 0;
            lastSpeedEmitAt = 0;
            events.onStreamReset?.();
          },
        );
        finishReason = normalizeFinishReason(result.finishReason, result.toolCalls.length, result.content.trim().length > 0);
        contextRecoveries = 0;
        await this.options.trace?.("model.result", {model: this.model.model, provider: this.model.providerId ?? null, step, finishReason, usage: result.usage});
        if (events.onSpeed) {
          const finishedAt = Date.now();
          const toolCallChars = result.toolCalls.reduce(
            (acc, tc) =>
              acc + tc.function.name.length + tc.function.arguments.length,
            0,
          );
          const totalGenChars =
            Math.max(
              streamedChars,
              result.content.length + (result.reasoning?.length ?? 0),
            ) + toolCallChars;
          const reportedCompletion = result.usage?.completion_tokens ?? 0;
          const outputTokens =
            reportedCompletion > 0
              ? reportedCompletion
              : Math.max(1, Math.round(totalGenChars / 3.8));
          const anchor =
            firstTokenAt !== null && finishedAt - firstTokenAt >= 25
              ? firstTokenAt
              : stepStartedAt;
          const genSec = Math.max(0.025, (finishedAt - anchor) / 1000);
          events.onSpeed({
            tps: Number((outputTokens / genSec).toFixed(1)),
            outputTokens,
            ttftMs:
              firstTokenAt !== null
                ? Math.max(0, firstTokenAt - stepStartedAt)
                : Math.max(0, finishedAt - stepStartedAt),
            elapsedMs: Math.max(1, finishedAt - stepStartedAt),
            live: false,
          });
        }
        if (result.usage) {
          const reportedContext =
            (result.usage.prompt_tokens ?? 0) +
              (result.usage.completion_tokens ?? 0) ||
            (result.usage.total_tokens ?? 0);
          // Covers the history sent plus the assistant message pushed below.
          if (reportedContext > 0)
            this.lastUsage = {
              tokens: reportedContext,
              count: this.messages.length + 1,
            };
          turnUsage = mergeUsage(turnUsage, result.usage);
          const stepTotal =
            result.usage.total_tokens ??
            (result.usage.prompt_tokens ?? 0) +
              (result.usage.completion_tokens ?? 0);
          this.cumulativeTokens += stepTotal;
          events.onUsage?.(turnUsage!, this.totalTokens);
          events.onContext?.(this.contextUsage());
        }
        streamed = {
          content: result.content,
          toolCalls: result.toolCalls,
          reasoningContent: result.reasoningContent ?? null,
          thinkingBlocks: result.thinkingBlocks ?? [],
        };
      } catch (error) {
        await this.options.trace?.("model.failed", {model: this.model.model, provider: this.model.providerId ?? null, step, aborted: signal?.aborted ?? false, message: error instanceof Error ? error.message : String(error)});
        events.onAssistantEnd?.(partialDelta);
        if (error instanceof BudgetExceededError) {
          events.onBudgetReached?.({usedTokens:error.totalTokens,budgetTokens:error.budgetTokens,step});
          return {text:`[omr] ${error.message}`,steps:step-1,toolCalls:totalToolCalls,aborted:false,status:"budget_exhausted",finishReason:"budget",usage:turnUsage};
        }
        const overflow = contextOverflowOf(error);
        if (overflow && !signal?.aborted) {
          if (contextRecoveries < MAX_CONTEXT_RECOVERIES && this.settings().strategy !== "off") {
            contextRecoveries += 1;
            const before = this.contextUsage().tokens;
            this.observedContextWindow = overflow.contextWindow ?? Math.max(1024, Math.floor(Math.min(this.settings().contextWindow, before) * 0.75));
            const recovery = this.settings();
            this.compact({force: true, protectRecentTools: 0, protectTailTokens: 0, targetBudget: Math.max(256, Math.floor((recovery.contextWindow - (recovery.outputReserveTokens ?? 0)) * 0.6 * 4))});
            if (this.contextUsage().tokens >= before) this.trimToWindow();
            await this.options.historyCheckpoint?.(this.history, "overflow-recovery");
            await this.options.trace?.("context.recovery", {beforeTokens: before, afterTokens: this.contextUsage().tokens, window: this.observedContextWindow});
            if (this.contextUsage().tokens < before) { step -= 1; continue; }
          }
          return {text: `[omr] model context limit reached; the answer is partial. ${error instanceof Error ? error.message : String(error)}`, steps: step, toolCalls: totalToolCalls, aborted: false, status: "partial", finishReason: "context_window", usage: turnUsage};
        }
        if (isAbort(error) || signal?.aborted) {
          if (partialDelta.trim().length > 0) {
            this.messages.push({ role: "assistant", content: partialDelta });
            latestText = partialDelta;
          } else if (pristine()) {
            // Aborted on step 1 before any assistant/tool output: roll back orphaned user turn.
            this.messages.splice(initialHistoryLength);
          }
          return {
            text: latestText || richestText,
            steps: step,
            toolCalls: totalToolCalls,
            aborted: true,
            status: "cancelled", finishReason,
            usage: turnUsage,
          };
        }
        if (pristine()) this.messages.splice(initialHistoryLength);
        throw error;
      }

      const assistant: ChatMessage = {
        role: "assistant",
        content: streamed.content || null,
      };
      const incomplete = finishReason !== "stop" && finishReason !== "tool_calls";
      if (!incomplete && streamed.toolCalls.length > 0) {
        assistant.tool_calls = streamed.toolCalls;
        // Thinking state is only needed to continue this tool loop.
        if (streamed.reasoningContent)
          assistant.reasoning_content = streamed.reasoningContent;
        if (streamed.thinkingBlocks.length > 0)
          assistant.thinking_blocks = streamed.thinkingBlocks;
      }
      this.messages.push(assistant);
      if (this.lastUsage && this.lastUsage.count !== this.messages.length) {
        this.lastUsage = {
          tokens: this.lastUsage.tokens,
          count: this.messages.length,
        };
      }

      if (streamed.content.trim().length > 0) {
        latestText = streamed.content;
        if (streamed.content.length >= richestText.length)
          richestText = streamed.content;
      }
      events.onAssistantEnd?.(streamed.content);
      await this.options.historyCheckpoint?.(this.history, "assistant");

      // A truncated tool call is not an executable instruction. Keep its visible text,
      // but never persist an unmatched protocol call or dispatch a partial side effect.
      const emptyToolTurn = finishReason === "tool_calls" && streamed.toolCalls.length === 0;
      const truncated = finishReason === "length";
      if ((emptyToolTurn || truncated) && turnRecoveries < MAX_TURN_RECOVERIES && step < stepBudget && !signal?.aborted) {
        // The model clearly wanted to keep working (tool_calls with nothing parseable, or output cut by
        // max_tokens, often because thinking consumed it). Do not end the turn: tell it what happened.
        turnRecoveries += 1;
        if (!streamed.content.trim()) this.messages.pop();
        this.messages.push({
          role: "user",
          content: emptyToolTurn
            ? "[omr] Your last response ended with finish_reason=tool_calls but contained no valid tool call. Re-issue the tool call with complete JSON arguments, or give your final answer."
            : "[omr] Your last response was cut off by the output token limit before it finished (any partial tool call was discarded). Think less, then issue the next tool call with compact arguments, or give your final answer.",
        });
        await this.options.trace?.("turn.recovery", {step, reason: finishReason, attempt: turnRecoveries});
        await this.options.historyCheckpoint?.(this.history, "turn-recovery");
        continue;
      }
      if (incomplete || emptyToolTurn) {
        return {
          text: latestText || richestText, steps: step, toolCalls: totalToolCalls,
          aborted: false, status: "partial", finishReason, usage: turnUsage,
        };
      }

      if (streamed.toolCalls.length === 0) {
        if (flushPendingSteers(step)) {
          continue;
        }
        const review = await this.options.reviewCompletion?.();
        if (review && !review.accepted) {
          this.messages.push({role:"user",content:review.message});
          await this.options.historyCheckpoint?.(this.history,"completion-review");
          if (++completionReviews <= 2 && step < stepBudget) {latestText="";richestText="";continue;}
          return {text:`${latestText||richestText}\n\n[omr] Analysis remains partial: explicit provider questions have no recorded decision.`,steps:step,toolCalls:totalToolCalls,aborted:false,status:"partial",finishReason:"investigation_review",usage:turnUsage};
        }
        const finalReport =
          richestText !== latestText &&
          richestText.length > latestText.length + 120 &&
          !latestText.includes(richestText.slice(0, 80))
            ? `${richestText}\n\n${latestText}`.trim()
            : latestText || richestText;
        return {
          text: finalReport,
          steps: step,
          toolCalls: totalToolCalls,
          aborted: false,
          status: "completed", finishReason,
          usage: turnUsage,
        };
      }

      // Execute tool calls while preserving the OpenAI invariant: every assistant
      // tool_call MUST have a matching role="tool" message in history, even on abort.
      // Consecutive read-only calls run in bounded parallel batches (max 4 concurrent)
      // while session-mutating calls execute sequentially.
      const parsedCalls = streamed.toolCalls.map((call) => {
        const name = call.function.name;
        let args: Record<string, unknown> = {};
        let parseProblem: string | null = null;
        try {
          const parsed: unknown = JSON.parse(call.function.arguments || "{}");
          const record = asRecord(parsed);
          if (!record || Array.isArray(parsed)) parseProblem = "Tool arguments must be a JSON object.";
          else args = record;
        } catch (error) {
          parseProblem = `Invalid tool arguments JSON: ${error instanceof Error ? error.message : String(error)}`;
        }
        let readOnly = false;
        try { readOnly = !parseProblem && (this.broker.isReadOnly?.(name, args) ?? false); }
        catch (error) { parseProblem = error instanceof Error ? error.message : String(error); }
        return { call, name, args, parseProblem, readOnly };
      });

      let idx = 0;
      const stepToolImages: ChatImageBlock[] = [];
      const stepToolImageLabels: string[] = [];
      while (idx < parsedCalls.length) {
        if (signal?.aborted) {
          for (let rem = idx; rem < parsedCalls.length; rem += 1) {
            this.messages.push({
              role: "tool",
              tool_call_id: parsedCalls[rem]!.call.id,
              content: "[cancelled by user before execution]",
            });
          }
          return {
            text: latestText || richestText,
            steps: step,
            toolCalls: totalToolCalls,
            aborted: true,
            status: "cancelled", finishReason,
            usage: turnUsage,
          };
        }

        // Collect a contiguous wave of up to 4 read-only calls, or a single mutating call.
        const wave: typeof parsedCalls = [];
        if (parsedCalls[idx]!.readOnly) {
          while (
            idx < parsedCalls.length &&
            parsedCalls[idx]!.readOnly &&
            wave.length < 4
          ) {
            wave.push(parsedCalls[idx]!);
            idx += 1;
          }
        } else {
          wave.push(parsedCalls[idx]!);
          idx += 1;
        }

        for (const item of wave) {
          totalToolCalls += 1;
          events.onToolStart?.(item.call.id, item.name, item.args);
        }

        const outcomes = await Promise.all(
          wave.map(async (item): Promise<BrokerOutcome> => {
            if (item.parseProblem) {
              return {
                tool: item.name,
                text: item.parseProblem,
                isError: true,
                durationMs: 0,
                evidenceIds: [],
              };
            }
            // The guard only nudges: the call still runs (state may have changed even when arguments did
            // not), and the model is told it is repeating itself. It never ends or blocks the turn.
            const nudge = loopGuard.check(
              item.name,
              item.args,
              item.readOnly,
            );
            let outcome: BrokerOutcome;
            try {
              outcome = await abortable(
                this.broker.dispatch(
                  item.name,
                  item.args,
                  signal,
                  (message) => events.onToolProgress?.(item.call.id, message),
                  catalogVersion,
                ),
                signal,
              );
            } catch (error) {
              // A tool failing, timing out, or leaving an uncertain outcome is information for the model,
              // not the end of the turn. (Uncertain side effects stay recorded and block blind repeats.)
              const reason = error instanceof Error ? error.message : String(error);
              outcome = {
                tool: item.name,
                text: signal?.aborted ? "[cancelled by user]" : `[omr] ${item.name} did not complete: ${reason}`,
                isError: true,
                durationMs: 0,
                evidenceIds: [],
              };
            }
            if (nudge && !signal?.aborted) outcome = { ...outcome, text: `${nudge}\n\n${outcome.text}` };
            loopGuard.record(
              item.name,
              item.args,
              item.readOnly,
              outcome.isError,
            );
            return outcome;
          }),
        );

        for (let wIdx = 0; wIdx < wave.length; wIdx += 1) {
          const item = wave[wIdx]!;
          const outcome = outcomes[wIdx]!;
          if (!outcome.isError) stepToolSucceeded = true;
          if (!outcome.isError && progressBefore === undefined) for (const id of outcome.evidenceIds) {
            if (/^ev_[a-f0-9]{64}$/.test(id) && !this.progressEvidence.has(id)) { this.progressEvidence.add(id); stepMadeProgress = true; }
          }
          this.messages.push({
            role: "tool",
            tool_call_id: item.call.id,
            content: outcome.text,
          });
          if (outcome.images && outcome.images.length > 0) {
            stepToolImages.push(...outcome.images);
            stepToolImageLabels.push(outcome.tool);
          }
          events.onToolEnd?.(item.call.id, outcome);
        }

        if (signal?.aborted) {
          for (let rem = idx; rem < parsedCalls.length; rem += 1) {
            this.messages.push({
              role: "tool",
              tool_call_id: parsedCalls[rem]!.call.id,
              content: "[cancelled by user before execution]",
            });
          }
          return {
            text: latestText || richestText,
            steps: step,
            toolCalls: totalToolCalls,
            aborted: true,
            status: "cancelled", finishReason,
            usage: turnUsage,
          };
        }
      }

      if (stepToolImages.length > 0) {
        this.messages.push({
          role: "user",
          content: `[omr: attached ${stepToolImages.length} visual image(s) from ${stepToolImageLabels.join(", ")} — examine the visual evidence directly]`,
          images: stepToolImages,
        });
      }

      turnRecoveries = 0;
      flushPendingSteers(step);
      await this.options.historyCheckpoint?.(this.history, "tool-results");
      await events.onCheckpoint?.();
      if (progressBefore !== undefined) stepMadeProgress = (this.options.progressEpoch?.() ?? progressBefore) > progressBefore;

      // Still working productively as the budget runs out: grant another block instead of
      // stopping with a partial answer that would need a manual "continue".
      // "Still working" means measured progress OR any successfully executed tool call: shell and browser
      // work (omr_run, camofox_evaluate) never produces REA Evidence, yet it is real work. Identical-call
      // loops are already answered with an error by the LoopGuard, so they do not count as activity.
      if (
        step === stepBudget &&
        (stepMadeProgress || stepToolSucceeded) &&
        extensionsUsed < maxExtensions
      ) {
        extensionsUsed += 1;
        stepBudget += maxSteps;
        events.onStepBudgetExtended?.({
          step,
          newBudget: stepBudget,
          extension: extensionsUsed,
          maxExtensions,
        });
      }
    }

    const base = richestText || latestText;
    const capNote = maxExtensions > 0 ? ` (${maxSteps} steps x ${maxExtensions + 1} blocks)` : "";
    return {
      text: `${base}\n\n[omr] step limit reached: ${stepBudget} model steps in one turn${capNote}. Send \`continue\` to resume from this context, or raise OMR_MAX_STEPS (steps per block, currently ${maxSteps}) / OMR_AUTO_EXTEND_STEPS (extra blocks, currently ${maxExtensions}).`.trim(),
      steps: stepBudget,
      toolCalls: totalToolCalls,
      aborted: false,
      status: "partial", finishReason: "step_budget",
      usage: turnUsage,
    };
  }
}
