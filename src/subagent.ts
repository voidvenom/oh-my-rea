import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, type AgentBroker } from "./agent.js";
import {
  summarizeToolCall,
  type BrokerOutcome,
  type ReaBroker,
  type ToolSelectionContext,
} from "./broker.js";
import type { LocalizedMessage } from "./i18n/index.js";
import type { ModelPort, ToolDefinition } from "./model.js";
import { findOmrWorkflow } from "./prompts.js";
import { asArray, asRecord, asString } from "./values.js";
import { abortable, ConcurrencyLimiter } from "./concurrency.js";
import type { SessionBinding } from "./runtime/sessionRuntime.js";

/** Subagent step cap is opt-in (`max_steps` >= 2); `0` means unlimited. */
const stepCap = (maxSteps: number): string => (maxSteps > 0 ? String(maxSteps) : "∞");
export const SUBAGENT_MAX_CONCURRENCY = 4;

const BLOCKED_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  "open_binary",
  "close_binary",
  "open_bundle_resources",
  "reset_investigation",
  "omr_task",
]);

const EVIDENCE_GLOBAL_RE = /\bev_[0-9a-f]{64}\b/g;
const UNKNOWN_GLOBAL_RE = /\bunk_[A-Za-z0-9_-]{6,64}\b/g;

export type SubagentStatus =
  | "queued"
  | "waiting_deps"
  | "running"
  | "steered"
  | "completed"
  | "partial"
  | "budget_exhausted"
  | "failed"
  | "cancelled";

export interface SubagentToolTrace {
  readonly callId: string;
  readonly tool: string;
  readonly displayTool: string;
  readonly argsSummary: string;
  status: "running" | "ok" | "error";
  durationMs: number | null;
  evidenceIds: string[];
  resultPreview: string;
}

export interface SubagentStepTrace {
  readonly step: number;
  readonly turnNumber: number;
  readonly startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  phase: "thinking" | "tool_exec" | "steered" | "done";
  reasoningPreview: string;
  textPreview: string;
  steersApplied: string[];
  tools: SubagentToolTrace[];
}

export interface SubagentSteerEvent {
  readonly index: number;
  readonly timestamp: string;
  readonly prompt: string;
  readonly mode: "mid-flight" | "resumed-turn";
  readonly appliedAtStep: number | null;
}

export interface SubagentNodeSnapshot {
  readonly id: string;
  readonly role: string;
  readonly workflow: string | null;
  readonly goal: string;
  readonly parentId: string;
  readonly dependsOn: readonly string[];
  readonly mode: "wait" | "background";
  readonly status: SubagentStatus;
  readonly finishReason: string | null;
  readonly binding: SessionBinding | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly currentStep: number;
  readonly maxSteps: number;
  readonly currentActivity: string;
  readonly turnsRun: number;
  readonly totalSteps: number;
  readonly totalToolCalls: number;
  readonly totalTokens: number;
  readonly evidenceIds: readonly string[];
  readonly unknownIds: readonly string[];
  readonly steers: readonly SubagentSteerEvent[];
  readonly stepsLog: readonly SubagentStepTrace[];
  readonly summary: string;
  readonly error: string | null;
}

export interface SubagentGraphSnapshot {
  readonly updatedAt: string;
  readonly counts: {
    readonly total: number;
    readonly running: number;
    readonly waiting: number;
    readonly completed: number;
    readonly steered: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly partial: number;
    readonly budgetExhausted: number;
    readonly totalEvidence: number;
    readonly totalTokens: number;
  };
  readonly nodes: readonly SubagentNodeSnapshot[];
  readonly edges: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly kind: "spawn" | "depends_on" | "steer";
  }>;
}

export interface SubagentTaskRequest {
  readonly id?: string | undefined;
  readonly role?: string | undefined;
  readonly goal: string;
  readonly workflow?: string | undefined;
  readonly maxSteps?: number | undefined;
  readonly mode?: "wait" | "background" | undefined;
  readonly dependsOn?: readonly string[] | undefined;
  readonly parentId?: string | undefined;
}

export interface SubagentTaskResult {
  readonly id: string;
  readonly role: string;
  readonly status: SubagentStatus;
  readonly finishReason: string | null;
  readonly ok: boolean;
  readonly workflow: string | null;
  readonly summary: string;
  readonly steps: number;
  readonly toolCalls: number;
  readonly totalTokens: number;
  readonly evidenceIds: readonly string[];
  readonly unknownIds: readonly string[];
  readonly steersCount: number;
  readonly stepsLog: readonly SubagentStepTrace[];
}

export type SubagentMetaAction =
  | "spawn"
  | "status"
  | "graph"
  | "inspect"
  | "steer"
  | "wait"
  | "cancel";

/**
 * Wrap `ReaBroker` for an isolated child subagent:
 * - Exposes read-only REA inspection tools, `omr_workflow`, `omr_run` (sandboxed script runner),
 *   `rea_tools`, `rea_guide`, `rea_prompt`, and `rea_call` to read-only REA tools.
 * - Blocks session-mutating tools (`open_binary`, `close_binary`, `reset_investigation`) and
 *   recursive `omr_task` calls so concurrent subagents cannot clobber parent session state.
 */
export const createReadOnlySubagentBroker = (
  parent: ReaBroker,
  collector?: {
    onOutcome?: (outcome: BrokerOutcome) => void;
  },
): AgentBroker => {
  const isAllowedTool = (
    name: string,
    args: Record<string, unknown>,
  ): boolean => {
    if (BLOCKED_SUBAGENT_TOOLS.has(name)) return false;
    if (name === "omr_run") return true;
    if (name === "rea_call") {
      const nested = asString(args["name"]);
      if (!nested || BLOCKED_SUBAGENT_TOOLS.has(nested)) return false;
      return parent.isReadOnly("rea_call", args);
    }
    return parent.isReadOnly(name, args);
  };

  return {
    beginTurn: (input?: string) => {
      parent.beginTurn(input);
    },
    isReadOnly: (name: string, args: Record<string, unknown>) =>
      name !== "omr_run" && isAllowedTool(name, args),
    catalogVersion: () => parent.catalogVersion(),
    definitions: (context?: ToolSelectionContext): ToolDefinition[] =>
      parent
        .definitions(context)
        .filter((def) => !BLOCKED_SUBAGENT_TOOLS.has(def.function.name)),
    dispatch: async (
      name: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
      onProgress?: (message: string) => void,
      expectedCatalogVersion?: string,
    ): Promise<BrokerOutcome> => {
      if (!isAllowedTool(name, args)) {
        const effective =
          name === "rea_call" ? asString(args["name"]) || name : name;
        return {
          tool: name,
          text: `Subagent read-only boundary: tool "${effective}" mutates session or runtime state and is reserved for the primary agent. Report the required action and exact target/address back to the parent agent.`,
          isError: true,
          durationMs: 0,
          evidenceIds: [],
        };
      }
      const outcome = await parent.dispatch(name, args, signal, onProgress, expectedCatalogVersion);
      collector?.onOutcome?.(outcome);
      return outcome;
    },
  };
};

const subagentSystemPrompt = (options: {
  id: string;
  role: string;
  target: string | null;
  targetFormat: string | null;
  sessionDir: string;
  workflowSummary: string | null;
}): string =>
  `You are **OMR Subagent \`${options.id}\`** (role: **${options.role}**), an isolated, steerable reverse-engineering subagent working inside the OMR Subagent Mesh.
- Target: ${options.target ?? "(unbound)"}${options.targetFormat ? ` (${options.targetFormat})` : ""}
- Session directory: ${options.sessionDir}
${options.workflowSummary ? `- Assigned workflow lens: ${options.workflowSummary}\n` : ""}- Use read-only REA inspection tools (and \`omr_run\` if verifying a decoder/parser against \`read_bytes\` data) to answer ONLY your assigned sub-task with high precision.
- Session-mutating tools (\`open_binary\`, \`close_binary\`, \`omr_task\`) are disabled inside subagents; inspect the already-open session or pass explicit \`path\`/\`input_path\` to target-free tools.
- If a \`[SUPERVISOR COURSE-CORRECTION / STEERING DIRECTIVE]\` arrives mid-investigation, immediately pivot your analysis to honor the supervisor's correction without repeating discarded work.
- Cite full 64-hex \`[ev_<id>]\` identifiers inline beside every observed address, symbol, string, or byte sequence, and distinguish Observed facts from Inferred conclusions and Unresolved gaps.
- Keep your final response dense and concise so the parent agent receives maximum signal with minimal context tokens.`;

interface ManagedSubagentNode {
  readonly id: string;
  readonly role: string;
  readonly workflow: string | null;
  readonly goal: string;
  readonly parentId: string;
  readonly dependsOn: string[];
  readonly mode: "wait" | "background";
  status: SubagentStatus;
  finishReason: string | null;
  readonly binding: SessionBinding | null;
  readonly createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  startedPerf: number | null;
  durationMs: number | null;
  currentStep: number;
  maxSteps: number;
  currentActivity: string;
  turnsRun: number;
  totalSteps: number;
  totalToolCalls: number;
  totalTokens: number;
  readonly evidenceSet: Set<string>;
  readonly unknownSet: Set<string>;
  readonly steers: SubagentSteerEvent[];
  readonly pendingSteers: string[];
  readonly stepsLog: SubagentStepTrace[];
  summary: string;
  error: string | null;
  agent: Agent | null;
  abortController: AbortController | null;
  activePromise: Promise<SubagentTaskResult> | null;
  notifiedParent: boolean;
}

const clipPreview = (text: string, maxChars = 220): string => {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}…`;
};

const toNodeSnapshot = (node: ManagedSubagentNode): SubagentNodeSnapshot => ({
  id: node.id,
  role: node.role,
  workflow: node.workflow,
  goal: node.goal,
  parentId: node.parentId,
  dependsOn: [...node.dependsOn],
  mode: node.mode,
  status: node.status,
  finishReason: node.finishReason,
  binding: node.binding,
  createdAt: node.createdAt,
  startedAt: node.startedAt,
  endedAt: node.endedAt,
  durationMs:
    node.durationMs ??
    (node.startedPerf !== null
      ? Math.round(performance.now() - node.startedPerf)
      : null),
  currentStep: node.currentStep,
  maxSteps: node.maxSteps,
  currentActivity: node.currentActivity,
  turnsRun: node.turnsRun,
  totalSteps: node.totalSteps,
  totalToolCalls: node.totalToolCalls,
  totalTokens: node.totalTokens,
  evidenceIds: [...node.evidenceSet],
  unknownIds: [...node.unknownSet],
  steers: node.steers.map((s) => ({ ...s })),
  stepsLog: node.stepsLog.map((st) => ({
    ...st,
    steersApplied: [...st.steersApplied],
    tools: st.tools.map((t) => ({ ...t, evidenceIds: [...t.evidenceIds] })),
  })),
  summary: node.summary,
  error: node.error,
});

const toTaskResult = (node: ManagedSubagentNode): SubagentTaskResult => ({
  id: node.id,
  role: node.role,
  status: node.status,
  finishReason: node.finishReason,
  ok: node.status === "completed",
  workflow: node.workflow,
  summary: node.summary || node.error || "(subagent produced no summary text)",
  steps: node.totalSteps,
  toolCalls: node.totalToolCalls,
  totalTokens: node.totalTokens,
  evidenceIds: [...node.evidenceSet],
  unknownIds: [...node.unknownSet],
  steersCount: node.steers.length,
  stepsLog: toNodeSnapshot(node).stepsLog,
});

/**
 * Stateful, Steerable, Observable Subagent Mesh & DAG Orchestrator.
 * Supports foreground (`wait`) and non-blocking (`background`) execution, upstream `dependsOn` DAG edges,
 * real-time step/tool/reasoning telemetry, and supervisor course-correction (`steer`) mid-flight or post-turn.
 */
export class SubagentRunner {
  private readonly limiter = new ConcurrencyLimiter(SUBAGENT_MAX_CONCURRENCY);
  private readonly nodes = new Map<string, ManagedSubagentNode>();
  private readonly completedBgNotifications: string[] = [];
  private seq = 0;

  constructor(
    private readonly deps: {
      readonly getModel: (id?: string) => ModelPort | null;
      readonly getBroker: () => Promise<ReaBroker>;
      readonly getTarget: () => string | null;
      readonly getTargetFormat: () => string | null;
      readonly getSessionDir: () => string;
      readonly getBinding?: (() => SessionBinding) | undefined;
      readonly withTargetLease?: (<T>(binding: SessionBinding, work: () => Promise<T>, signal?: AbortSignal) => Promise<T>) | undefined;
      readonly historyCheckpoint?: ((scope: string, messages: readonly import("./model.js").ChatMessage[], reason: string) => Promise<void>) | undefined;
      readonly archiveProjection?: import("./agent.js").AgentOptions["archiveProjection"];
      readonly progressEpoch?: (() => number) | undefined;
      readonly beforeStep?: import("./agent.js").AgentOptions["beforeStep"];
      readonly stepContext?: import("./agent.js").AgentOptions["stepContext"];
      readonly turnContext?: (() => string | null) | undefined;
      readonly trace?: ((scope: string, type: string, data: Record<string, unknown>) => Promise<void>) | undefined;
      readonly onProgress?: ((message: string, localize: LocalizedMessage) => void) | undefined;
      readonly onEvidenceCollected?:
        | ((evidenceIds: readonly string[]) => void)
        | undefined;
    },
  ) {}

  private allocateId(hint?: string): string {
    this.seq += 1;
    const cleanHint = (hint ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
    const candidate = cleanHint ? `sub-${this.seq}-${cleanHint}` : `sub-${this.seq}`;
    return this.nodes.has(candidate) ? `sub-${this.seq}` : candidate;
  }

  private resolveNode(idOrPrefix: string): ManagedSubagentNode | undefined {
    const query = idOrPrefix.trim().toLowerCase();
    if (!query) return undefined;
    const exact = this.nodes.get(query);
    if (exact) return exact;
    for (const node of this.nodes.values()) {
      if (
        node.id.toLowerCase() === query ||
        node.id.toLowerCase().startsWith(query) ||
        node.role.toLowerCase() === query
      ) {
        return node;
      }
    }
    return undefined;
  }

  private persistSnapshot(): void {
    const sessionDir = this.deps.getSessionDir();
    if (!sessionDir) return;
    const snap = this.graphSnapshot();
    const outPath = join(sessionDir, "subagents.json");
    void writeFile(outPath, `${JSON.stringify(snap, null, 2)}\n`, {
      mode: 0o600,
    }).catch(() => {});
  }

  /** Drain completion notifications from background subagents so the parent agent is alerted on its next step. */
  consumeCompletedNotifications(): string | null {
    if (this.completedBgNotifications.length === 0) return null;
    const notes = this.completedBgNotifications.splice(
      0,
      this.completedBgNotifications.length,
    );
    return `[omr subagent mesh notification:\n${notes.join("\n")}\n]`;
  }

  /** Return a live, serializable DAG snapshot of all subagents, their steps, tools, steers, and edges. */
  graphSnapshot(): SubagentGraphSnapshot {
    const list = [...this.nodes.values()].map(toNodeSnapshot);
    const allEv = new Set<string>();
    let totalTokens = 0;
    let running = 0;
    let waiting = 0;
    let completed = 0;
    let steered = 0;
    let failed = 0;
    let cancelled = 0;
    let partial = 0;
    let budgetExhausted = 0;

    const edges: Array<{
      from: string;
      to: string;
      kind: "spawn" | "depends_on" | "steer";
    }> = [];

    for (const node of list) {
      for (const ev of node.evidenceIds) allEv.add(ev);
      totalTokens += node.totalTokens;
      if (node.status === "running" || node.status === "steered") running += 1;
      else if (node.status === "queued" || node.status === "waiting_deps")
        waiting += 1;
      else if (node.status === "completed") completed += 1;
      else if (node.status === "failed") failed += 1;
      else if (node.status === "cancelled") cancelled += 1;
      else if (node.status === "partial") partial += 1;
      else if (node.status === "budget_exhausted") budgetExhausted += 1;
      if (node.steers.length > 0) steered += 1;

      if (node.dependsOn.length === 0) {
        edges.push({ from: node.parentId, to: node.id, kind: "spawn" });
      } else {
        for (const dep of node.dependsOn) {
          edges.push({ from: dep, to: node.id, kind: "depends_on" });
        }
      }
      if (node.steers.length > 0) {
        edges.push({ from: node.parentId, to: node.id, kind: "steer" });
      }
    }

    return {
      updatedAt: new Date().toISOString(),
      counts: {
        total: list.length,
        running,
        waiting,
        completed,
        steered,
        failed,
        cancelled,
        partial,
        budgetExhausted,
        totalEvidence: allEv.size,
        totalTokens,
      },
      nodes: list,
      edges,
    };
  }

  getNodeSnapshot(idOrPrefix: string): SubagentNodeSnapshot | null {
    const found = this.resolveNode(idOrPrefix);
    return found ? toNodeSnapshot(found) : null;
  }

  /**
   * Spawn a subagent in either blocking (`mode: "wait"`, default) or non-blocking (`mode: "background"`) mode.
   * Remains backwards-compatible with `runTask(request, signal, onProgress)`.
   */
  async runTask(
    request: SubagentTaskRequest,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<SubagentTaskResult> {
    const { node, promise } = this.spawnNode(request, signal, onProgress);
    if (request.mode === "background") {
      return toTaskResult(node);
    }
    return promise;
  }

  spawnNode(
    request: SubagentTaskRequest,
    parentSignal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): { node: ManagedSubagentNode; promise: Promise<SubagentTaskResult> } {
    const goal = request.goal.trim();
    const wf = request.workflow?.trim()
      ? findOmrWorkflow(request.workflow)
      : undefined;
    const role =
      request.role?.trim() ||
      (wf ? `${wf.id}-analyst` : "re-subagent");
    const id = this.allocateId(request.id ?? request.role ?? wf?.id);
    const maxSteps = request.maxSteps !== undefined && request.maxSteps >= 2 ? Math.trunc(request.maxSteps) : 0;
    const dependsOn = (request.dependsOn ?? [])
      .map((d) => this.resolveNode(d)?.id ?? d.trim())
      .filter(Boolean);

    const node: ManagedSubagentNode = {
      id,
      role,
      workflow: wf?.id ?? null,
      goal,
      parentId: request.parentId?.trim() || "root",
      dependsOn,
      mode: request.mode ?? "wait",
      status: dependsOn.length > 0 ? "waiting_deps" : "queued",
      finishReason: null,
      binding: this.deps.getBinding?.() ?? null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      startedPerf: null,
      durationMs: null,
      currentStep: 0,
      maxSteps,
      currentActivity:
        dependsOn.length > 0
          ? `waiting for ${dependsOn.join(", ")}`
          : "queued in mesh",
      turnsRun: 0,
      totalSteps: 0,
      totalToolCalls: 0,
      totalTokens: 0,
      evidenceSet: new Set<string>(),
      unknownSet: new Set<string>(),
      steers: [],
      pendingSteers: [],
      stepsLog: [],
      summary: "",
      error: null,
      agent: null,
      abortController: null,
      activePromise: null,
      notifiedParent: false,
    };
    this.nodes.set(id, node);
    this.persistSnapshot();

    const promise = this.executeNodeTurn(
      node,
      goal,
      wf?.buildPrompt({
        target: this.deps.getTarget(),
        focus: goal,
      }) ?? null,
      parentSignal,
      onProgress,
    );
    node.activePromise = promise;
    return { node, promise };
  }

  private async executeNodeTurn(
    node: ManagedSubagentNode,
    userGoal: string,
    workflowPrompt: string | null,
    parentSignal?: AbortSignal,
    onProgress?: (message: string) => void,
    isResumedSteer = false,
  ): Promise<SubagentTaskResult> {
    const abort = new AbortController();
    node.abortController = abort;
    node.status = node.dependsOn.length > 0 && !isResumedSteer ? "waiting_deps" : "queued";
    node.error = null;
    const onParentAbort = (): void => abort.abort(parentSignal?.reason);
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    try {
      abort.signal.throwIfAborted();
      if (!userGoal) throw new Error("Subagent requires a non-empty `goal`.");
      const model = this.deps.getModel(node.id);
      if (!model) throw new Error("No active model configured to execute subagent task.");

      // Dependencies can only refer to already-created nodes, so every edge points
      // backwards in creation order. Unknown/self references cannot form a cycle.
      if (!isResumedSteer && node.dependsOn.length > 0) {
        node.status = "waiting_deps";
        node.currentActivity = `waiting for upstream: ${node.dependsOn.join(", ")}`;
        this.persistSnapshot();
        for (const depId of node.dependsOn) {
          const depNode = this.resolveNode(depId);
          if (!depNode || depNode === node) throw new Error(`Invalid upstream dependency: ${depId}`);
          if (depNode.activePromise) await abortable(depNode.activePromise, abort.signal);
          abort.signal.throwIfAborted();
          if (depNode.status !== "completed") throw new Error(`Upstream ${depNode.id} did not complete (${depNode.status})`);
        }
      }

      return await this.limiter.run(async () => {
        const execute = async (): Promise<SubagentTaskResult> => {
        const notify = (msg: string, localize: LocalizedMessage): void => {
          node.currentActivity = msg;
          onProgress?.(`[${node.id}] ${msg}`);
          this.deps.onProgress?.(`[${node.id}] ${msg}`, (t) => `[${node.id}] ${localize(t)}`);
          this.persistSnapshot();
        };

        const parentBroker = await abortable(this.deps.getBroker(), abort.signal);
        abort.signal.throwIfAborted();
        const target = this.deps.getTarget();
        const targetFormat = this.deps.getTargetFormat();
        const sessionDir = this.deps.getSessionDir();
        const wf = node.workflow ? findOmrWorkflow(node.workflow) : undefined;

        const collectIds = (
          text: string,
          directEvs?: readonly string[],
        ): void => {
          const newlyAdded: string[] = [];
          for (const id of directEvs ?? []) {
            if (!node.evidenceSet.has(id)) newlyAdded.push(id);
            node.evidenceSet.add(id);
          }
          for (const match of text.matchAll(EVIDENCE_GLOBAL_RE)) {
            if (!node.evidenceSet.has(match[0])) newlyAdded.push(match[0]);
            node.evidenceSet.add(match[0]);
          }
          for (const match of text.matchAll(UNKNOWN_GLOBAL_RE)) {
            node.unknownSet.add(match[0]);
          }
          if (newlyAdded.length > 0) {
            this.deps.onEvidenceCollected?.(newlyAdded);
          }
        };

        if (!node.agent) {
          const childBroker = createReadOnlySubagentBroker(parentBroker, {
            onOutcome: (outcome) => collectIds(outcome.text, outcome.evidenceIds),
          });
          node.agent = new Agent(model, childBroker, {
            historyCheckpoint: (messages, reason) => this.deps.historyCheckpoint?.(node.id, messages, reason) ?? Promise.resolve(),
            archiveProjection: this.deps.archiveProjection,
            trace: (type, data) => this.deps.trace?.(node.id, type, data) ?? Promise.resolve(),
            systemPrompt: () =>
              subagentSystemPrompt({
                id: node.id,
                role: node.role,
                target,
                targetFormat,
                sessionDir,
                workflowSummary: wf ? `/${wf.id} — ${wf.summary}` : null,
              }),
            toolContext: () => ({ targetPath: target, targetFormat }),
            ...(this.deps.progressEpoch ? { progressEpoch: this.deps.progressEpoch } : {}),
            beforeStep: this.deps.beforeStep,
            stepContext: this.deps.stepContext,
            ...(this.deps.turnContext ? { turnContext: this.deps.turnContext } : {}),
            maxSteps: node.maxSteps,
          });
        } else {
          node.agent.setModel(model);
        }

        // Attach upstream dependency context if this is the initial turn and `dependsOn` nodes completed
        let upstreamContext = "";
        if (!isResumedSteer && node.dependsOn.length > 0) {
          const depBlocks: string[] = [];
          for (const depId of node.dependsOn) {
            const depNode = this.resolveNode(depId);
            if (!depNode) continue;
            depBlocks.push(
              `Upstream subagent \`${depNode.id}\` (${depNode.role}) findings [ev: ${[...depNode.evidenceSet].join(", ") || "none"}]:\n${depNode.summary}`,
            );
          }
          if (depBlocks.length > 0) {
            upstreamContext = `\n\n# Upstream Subagent DAG Inputs\n${depBlocks.join("\n\n")}`;
          }
        }

        let taskPrompt = isResumedSteer
          ? `[SUPERVISOR COURSE-CORRECTION / STEERING DIRECTIVE]:\n${userGoal}\n\nRe-evaluate your previous findings, apply this course correction, and report updated Evidence-backed findings.`
          : workflowPrompt
            ? `${workflowPrompt}\n\nSubagent task focus: ${userGoal}${upstreamContext}`
            : `${userGoal}${upstreamContext}`;
        if (node.pendingSteers.length > 0) {
          taskPrompt += `\n\n[SUPERVISOR COURSE-CORRECTION / STEERING DIRECTIVE]:\n${node.pendingSteers.splice(0).join("\n")}`;
          for (const steer of node.steers) {
            if (steer.appliedAtStep === null) (steer as {appliedAtStep: number | null}).appliedAtStep = 1;
          }
        }

        if (!node.startedAt) {
          node.startedAt = new Date().toISOString();
          node.startedPerf = performance.now();
        }
        node.endedAt = null;
        node.status = isResumedSteer ? "steered" : "running";
        node.turnsRun += 1;
        const turnNumber = node.turnsRun;
        let activeStepTrace: SubagentStepTrace | null = null;
        let stepStartPerf = performance.now();

        const finalizeStep = (): void => {
          if (!activeStepTrace) return;
          activeStepTrace.endedAt = new Date().toISOString();
          activeStepTrace.durationMs = Math.round(
            performance.now() - stepStartPerf,
          );
          if (activeStepTrace.phase !== "steered") {
            activeStepTrace.phase = "done";
          }
        };

        notify(
          isResumedSteer
            ? `resumed with supervisor steering directive`
            : `starting (${node.role})`,
          (t) => isResumedSteer ? t("workflow.subagentResuming") : t("workflow.subagentStarting", { role: node.role }),
        );

        const tokensBefore = node.agent.ownTokens;
        const turn = await node.agent.run(
          taskPrompt,
          {
            onStep: (step) => {
              finalizeStep();
              node.currentStep = step;
              stepStartPerf = performance.now();
              activeStepTrace = {
                step,
                turnNumber,
                startedAt: new Date().toISOString(),
                endedAt: null,
                durationMs: null,
                phase: "thinking",
                reasoningPreview: "",
                textPreview: "",
                steersApplied: [],
                tools: [],
              };
              node.stepsLog.push(activeStepTrace);
              const limit = stepCap(node.maxSteps);
              notify(`step ${step}/${limit} · thinking`, (t) => t("workflow.subagentThinking", { step, limit }));
            },
            onReasoningDelta: (delta) => {
              if (!activeStepTrace) return;
              activeStepTrace.reasoningPreview = clipPreview(
                `${activeStepTrace.reasoningPreview} ${delta}`,
                240,
              );
            },
            onAssistantDelta: (delta) => {
              if (!activeStepTrace) return;
              activeStepTrace.textPreview = clipPreview(
                `${activeStepTrace.textPreview} ${delta}`,
                240,
              );
            },
            onToolStart: (callId, name, args) => {
              if (activeStepTrace) activeStepTrace.phase = "tool_exec";
              const { displayTool, summary } = summarizeToolCall(name, args);
              activeStepTrace?.tools.push({
                callId,
                tool: name,
                displayTool,
                argsSummary: summary,
                status: "running",
                durationMs: null,
                evidenceIds: [],
                resultPreview: "",
              });
              const step = node.currentStep;
              const limit = stepCap(node.maxSteps);
              const tool = `${displayTool}${summary ? `(${summary})` : ""}`;
              notify(`step ${step}/${limit} → ${tool}`, (t) => t("workflow.subagentTool", { step, limit, tool }));
            },
            onToolEnd: (callId, outcome) => {
              const trace = activeStepTrace?.tools.find(
                (t) => t.callId === callId,
              );
              if (trace) {
                trace.status = outcome.isError ? "error" : "ok";
                trace.durationMs = outcome.durationMs;
                trace.evidenceIds = [...outcome.evidenceIds];
                trace.resultPreview = clipPreview(outcome.text, 180);
              }
              this.persistSnapshot();
            },
            onSteerApplied: (directives, step) => {
              node.status = "steered";
              if (activeStepTrace) {
                activeStepTrace.phase = "steered";
                activeStepTrace.steersApplied.push(...directives);
              }
              for (const steer of node.steers) {
                if (steer.appliedAtStep === null) {
                  (steer as { appliedAtStep: number | null }).appliedAtStep =
                    step;
                }
              }
              const directive = clipPreview(directives.join("; "), 60);
              notify(`⚡ steered at step ${step}: "${directive}"`, (t) => t("workflow.subagentSteered", { step, directive }));
            },
          },
          abort.signal,
        );

        finalizeStep();
        node.finishReason = turn.finishReason;
        collectIds(turn.text);
        node.totalSteps += turn.steps;
        node.totalToolCalls += turn.toolCalls;
        node.totalTokens += Math.max(0, node.agent.ownTokens - tokensBefore);
        node.summary = turn.text.trim() || node.summary;
        node.endedAt = new Date().toISOString();
        if (node.startedPerf !== null) {
          node.durationMs = Math.round(performance.now() - node.startedPerf);
        }

        if (turn.aborted || abort.signal.aborted) {
          node.status = "cancelled";
          node.currentActivity = `cancelled at step ${turn.steps}`;
        } else if (turn.status !== "completed") {
          node.status = turn.status;
          node.currentActivity = `${turn.status} (${turn.finishReason ?? "execution limit"})`;
        } else {
          node.status = "completed";
          node.currentActivity = `completed (${node.totalSteps} steps · +${node.evidenceSet.size} ev_)`;
          if (node.mode === "background" && !node.notifiedParent) {
            node.notifiedParent = true;
            this.completedBgNotifications.push(
              `- Subagent \`${node.id}\` (${node.role}) COMPLETED (${node.totalSteps} steps, ${node.totalToolCalls} tools, +${node.evidenceSet.size} ev_ [${[...node.evidenceSet].slice(0, 6).join(", ")}]): ${clipPreview(node.summary, 280)}`,
            );
          }
        }
        this.persistSnapshot();
        return toTaskResult(node);
        };
        return this.deps.withTargetLease && node.binding
          ? this.deps.withTargetLease(node.binding, execute, abort.signal)
          : execute();
      }, abort.signal);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        node.status = abort.signal.aborted ? "cancelled" : "failed";
        node.error = msg;
        node.endedAt = new Date().toISOString();
        node.currentActivity = `${node.status}: ${clipPreview(msg, 80)}`;
        this.persistSnapshot();
        return toTaskResult(node);
    } finally {
        if (node.abortController === abort) node.abortController = null;
        parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }

  /**
   * Steer a running or already-finished subagent with a corrective supervisor prompt:
   * - If `running` / `steered` / `waiting_deps` / `queued`: queues the directive into the live `Agent` step loop.
   * - If `completed` / `failed` / `cancelled`: resumes the stateful `Agent` with its full history for a corrective turn.
   */
  async steer(
    idOrPrefix: string,
    prompt: string,
    options: {
      readonly wait?: boolean | undefined;
      readonly signal?: AbortSignal | undefined;
      readonly onProgress?: ((message: string) => void) | undefined;
    } = {},
  ): Promise<{
    readonly ok: boolean;
    readonly mode: "mid-flight" | "resumed-turn" | "not-found";
    readonly message: string;
    readonly node: SubagentNodeSnapshot | null;
    readonly result: SubagentTaskResult | null;
  }> {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
      return {
        ok: false,
        mode: "not-found",
        message: "Steer directive requires a non-empty prompt.",
        node: null,
        result: null,
      };
    }
    const node = this.resolveNode(idOrPrefix);
    if (!node) {
      return {
        ok: false,
        mode: "not-found",
        message: `No subagent found matching "${idOrPrefix}".`,
        node: null,
        result: null,
      };
    }

    if (node.abortController?.signal.aborted && node.activePromise) await node.activePromise;
    const isRunning =
      node.status === "running" ||
      node.status === "steered" ||
      node.status === "queued" ||
      node.status === "waiting_deps";

    if (isRunning) {
      node.steers.push({
        index: node.steers.length + 1,
        timestamp: new Date().toISOString(),
        prompt: cleanPrompt,
        mode: "mid-flight",
        appliedAtStep: null,
      });
      if (node.agent && node.status !== "queued" && node.status !== "waiting_deps") {
        node.status = "steered";
        node.agent.enqueueSteer(cleanPrompt);
      } else node.pendingSteers.push(cleanPrompt);
      node.currentActivity = `⚡ steer queued for next step: "${clipPreview(cleanPrompt, 50)}"`;
      this.persistSnapshot();

      if (options.wait && node.activePromise) {
        const result = await node.activePromise;
        return {
          ok: true,
          mode: "mid-flight",
          message: `Steered running subagent ${node.id} mid-flight and awaited completion.`,
          node: toNodeSnapshot(node),
          result,
        };
      }
      return {
        ok: true,
        mode: "mid-flight",
        message: `Queued mid-flight course correction for ${node.id}; it will take effect on the next step boundary.`,
        node: toNodeSnapshot(node),
        result: null,
      };
    }

    // A finished subagent resumes its stateful conversation in exactly one new execution.
    node.steers.push({
      index: node.steers.length + 1,
      timestamp: new Date().toISOString(),
      prompt: cleanPrompt,
      mode: "resumed-turn",
      appliedAtStep: node.currentStep + 1,
    });
    const wait = options.wait ?? true;
    const promise = this.executeNodeTurn(
      node,
      cleanPrompt,
      null,
      options.signal,
      options.onProgress,
      true,
    );
    node.activePromise = promise;
    if (!wait) {
      return {
        ok: true,
        mode: "resumed-turn",
        message: `Resumed subagent ${node.id} in the background with supervisor steering directive.`,
        node: toNodeSnapshot(node),
        result: null,
      };
    }
    const result = await promise;
    return {
      ok: result.ok,
      mode: "resumed-turn",
      message: `Resumed and steered subagent ${node.id} to completion.`,
      node: toNodeSnapshot(node),
      result,
    };
  }

  /** Wait for one, several, or all active subagents to complete. */
  async waitFor(
    ids?: readonly string[],
    timeoutMs = 120_000,
  ): Promise<SubagentTaskResult[]> {
    const targets: ManagedSubagentNode[] =
      ids && ids.length > 0
        ? ids
            .map((id) => this.resolveNode(id))
            .filter((n): n is ManagedSubagentNode => Boolean(n))
        : [...this.nodes.values()].filter(
            (n) =>
              n.status === "running" ||
              n.status === "steered" ||
              n.status === "queued" ||
              n.status === "waiting_deps",
          );

    if (targets.length === 0) {
      return [...this.nodes.values()].map(toTaskResult);
    }

    const waitAll = Promise.all(
      targets.map(async (n) => {
        if (n.activePromise) {
          return n.activePromise.catch(() => toTaskResult(n));
        }
        return toTaskResult(n);
      }),
    );

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      let timer: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<SubagentTaskResult[]>((resolve) => {
        timer = setTimeout(
          () => resolve(targets.map(toTaskResult)),
          timeoutMs,
        );
        timer.unref?.();
      });
      try {
        return await Promise.race([waitAll, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return waitAll;
  }

  /** Cancel a running subagent by ID or prefix. */
  cancel(idOrPrefix: string): SubagentNodeSnapshot | null {
    const node = this.resolveNode(idOrPrefix);
    if (!node) return null;
    if (!node.abortController) return toNodeSnapshot(node);
    if (node.abortController) {
      node.abortController.abort(new Error("Cancelled by supervisor"));
    }
    node.status = "cancelled";
    node.endedAt = new Date().toISOString();
    node.currentActivity = "cancelled by supervisor";
    this.persistSnapshot();
    return toNodeSnapshot(node);
  }

  async cancelAll(): Promise<void> {
    const active = [...this.nodes.values()].filter((node) => node.abortController);
    for (const node of active) this.cancel(node.id);
    await Promise.allSettled(active.map((node) => node.activePromise));
  }

  /**
   * Dispatch any `omr_task` meta-tool call (`spawn`, `status`/`graph`, `inspect`, `steer`, `wait`, `cancel`).
   */
  async dispatchMetaTool(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<{ text: string; isError: boolean; evidenceIds: string[] }> {
    const rawAction = asString(args["action"]).trim().toLowerCase() || "spawn";
    const action = (
      rawAction === "list" ? "status" : rawAction
    ) as SubagentMetaAction;

    if (action === "status" || action === "graph") {
      const snap = this.graphSnapshot();
      const allEv = snap.nodes.flatMap((n) => n.evidenceIds);
      return {
        text: renderSubagentGraph(snap),
        isError: false,
        evidenceIds: [...new Set(allEv)],
      };
    }

    if (action === "inspect") {
      const agentId =
        asString(args["agent_id"]).trim() || asString(args["id"]).trim();
      if (!agentId) {
        return {
          text: 'omr_task action="inspect" requires `agent_id` (e.g. "sub-1").',
          isError: true,
          evidenceIds: [],
        };
      }
      const snap = this.getNodeSnapshot(agentId);
      if (!snap) {
        return {
          text: `No subagent found matching "${agentId}". Call \`omr_task { action: "status" }\` to list active subagents.`,
          isError: true,
          evidenceIds: [],
        };
      }
      return {
        text: renderSubagentInspector(snap),
        isError: false,
        evidenceIds: [...snap.evidenceIds],
      };
    }

    if (action === "steer") {
      const agentId =
        asString(args["agent_id"]).trim() || asString(args["id"]).trim();
      const prompt =
        asString(args["prompt"]).trim() ||
        asString(args["directive"]).trim() ||
        asString(args["goal"]).trim();
      if (!agentId || !prompt) {
        return {
          text: 'omr_task action="steer" requires `agent_id` and `prompt` (or `goal`) with the course-correction directive.',
          isError: true,
          evidenceIds: [],
        };
      }
      const modeArg = asString(args["mode"]).trim().toLowerCase();
      const wait = modeArg !== "background";
      const steered = await this.steer(agentId, prompt, {
        wait,
        signal,
        onProgress,
      });
      if (!steered.ok) {
        return {
          text: steered.message,
          isError: true,
          evidenceIds: [],
        };
      }
      if (steered.result) {
        return {
          text: `${steered.message}\n\n${formatSubagentResult(steered.result)}`,
          isError: !steered.result.ok,
          evidenceIds: [...steered.result.evidenceIds],
        };
      }
      return {
        text: `${steered.message}\n\n${steered.node ? renderSubagentInspector(steered.node) : ""}`,
        isError: false,
        evidenceIds: steered.node ? [...steered.node.evidenceIds] : [],
      };
    }

    if (action === "wait") {
      const singleId =
        asString(args["agent_id"]).trim() || asString(args["id"]).trim();
      const multiIds = asArray(args["agent_ids"])
        .map((v) => asString(v).trim())
        .filter(Boolean);
      const ids = singleId ? [singleId, ...multiIds] : multiIds;
      const timeoutSec = Number(args["timeout_s"]);
      const timeoutMs =
        Number.isFinite(timeoutSec) && timeoutSec > 0
          ? Math.min(300_000, Math.trunc(timeoutSec * 1000))
          : 120_000;
      const results = await this.waitFor(
        ids.length > 0 ? ids : undefined,
        timeoutMs,
      );
      const allEv = new Set<string>();
      for (const r of results) {
        for (const ev of r.evidenceIds) allEv.add(ev);
      }
      const blocks = results.map((r) => formatSubagentResult(r));
      return {
        text:
          blocks.length > 0
            ? `${renderSubagentGraph(this.graphSnapshot())}\n\n${blocks.join("\n\n---\n\n")}`
            : "No subagents to wait on.",
        isError: false,
        evidenceIds: [...allEv],
      };
    }

    if (action === "cancel") {
      const agentId =
        asString(args["agent_id"]).trim() || asString(args["id"]).trim();
      if (!agentId) {
        return {
          text: 'omr_task action="cancel" requires `agent_id`.',
          isError: true,
          evidenceIds: [],
        };
      }
      const cancelled = this.cancel(agentId);
      if (!cancelled) {
        return {
          text: `No subagent found matching "${agentId}".`,
          isError: true,
          evidenceIds: [],
        };
      }
      return {
        text: `Cancelled subagent ${cancelled.id} (${cancelled.role}).`,
        isError: false,
        evidenceIds: [...cancelled.evidenceIds],
      };
    }

    // Default: action === "spawn"
    const goal =
      asString(args["goal"]).trim() || asString(args["prompt"]).trim();
    if (!goal) {
      return {
        text: 'omr_task action="spawn" requires a non-empty `goal` string.',
        isError: true,
        evidenceIds: [],
      };
    }
    const workflow = asString(args["workflow"]).trim() || undefined;
    const role = asString(args["role"]).trim() || undefined;
    const id = asString(args["id"]).trim() || undefined;
    const rawMode = asString(args["mode"]).trim().toLowerCase();
    const mode: "wait" | "background" =
      rawMode === "background" || rawMode === "bg" || rawMode === "async"
        ? "background"
        : "wait";
    const dependsOn = asArray(args["depends_on"])
      .map((v) => asString(v).trim())
      .filter(Boolean);
    const rawSteps = Number(args["max_steps"]);
    const maxSteps =
      Number.isFinite(rawSteps) && rawSteps >= 2
        ? Math.trunc(rawSteps)
        : undefined;

    const { node, promise } = this.spawnNode(
      {
        ...(id ? { id } : {}),
        ...(role ? { role } : {}),
        goal,
        ...(workflow ? { workflow } : {}),
        ...(maxSteps ? { maxSteps } : {}),
        mode,
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
      },
      signal,
      onProgress,
    );

    if (mode === "background") {
      return {
        text: [
          `[omr_task subagent spawned in background: \`${node.id}\` (${node.role})]`,
          `status: ${node.status} · workflow: ${node.workflow ? `/${node.workflow}` : "custom"} · max_steps: ${node.maxSteps > 0 ? node.maxSteps : "unlimited"}`,
          `goal: ${node.goal}`,
          `You can continue your own REA tool calls now, inspect live progress via \`omr_task { action: "inspect", agent_id: "${node.id}" }\`, course-correct it via \`omr_task { action: "steer", agent_id: "${node.id}", prompt: "..." }\`, or collect its final answer via \`omr_task { action: "wait", agent_id: "${node.id}" }\`.`,
        ].join("\n"),
        isError: false,
        evidenceIds: [],
      };
    }

    const result = await promise;
    return {
      text: formatSubagentResult(result),
      isError: !result.ok,
      evidenceIds: [...result.evidenceIds],
    };
  }
}

const statusIcon = (status: SubagentStatus, steeredCount: number): string => {
  switch (status) {
    case "running":
      return "◐ RUNNING";
    case "steered":
      return "⚡ STEERED";
    case "waiting_deps":
      return "⏳ WAITING_DEPS";
    case "queued":
      return "◌ QUEUED";
    case "completed":
      return steeredCount > 0 ? "● COMPLETED (↻ steered)" : "● COMPLETED";
    case "failed":
      return "✗ FAILED";
    case "cancelled":
      return "⊘ CANCELLED";
    case "partial":
      return "◑ PARTIAL";
    case "budget_exhausted":
      return "◑ BUDGET_EXHAUSTED";
  }
};

/**
 * Render the real-time Unicode DAG & step-by-step execution graph for all subagents in the mesh.
 */
export const renderSubagentGraph = (snap: SubagentGraphSnapshot): string => {
  if (snap.nodes.length === 0) {
    return [
      "╔══ OMR SUBAGENT MESH · 0 active/recorded subagents ══╗",
      "  No subagents have been spawned in this session yet.",
      "  • Spawn foreground:  /spawn [workflow] <goal>",
      "  • Spawn background:  /spawn --bg [workflow] <goal>",
      "  • Inspect node:      /subagents inspect <sub-id>",
      "  • Steer / correct:   /steer <sub-id> <correction prompt>",
    ].join("\n");
  }

  const lines: string[] = [
    `╔══ OMR SUBAGENT MESH DAG · ${snap.counts.total} node(s) (${snap.counts.running} running · ${snap.counts.waiting} waiting · ${snap.counts.completed} completed · ${snap.counts.steered} steered) · ${snap.counts.totalEvidence} ev_ · ${snap.counts.totalTokens} tok ══╗`,
    `Root Supervisor Agent (omr · primary)`,
  ];

  snap.nodes.forEach((node, idx) => {
    const isLastNode = idx === snap.nodes.length - 1;
    const branch = isLastNode ? "╰──►" : "├──►";
    const pipe = isLastNode ? "    " : "│   ";
    const wfTag = node.workflow ? `/${node.workflow}` : "custom";
    const depTag =
      node.dependsOn.length > 0
        ? ` [depends_on: ${node.dependsOn.join(", ")}]`
        : "";
    const durTag =
      node.durationMs !== null
        ? node.durationMs < 1000
          ? `${node.durationMs}ms`
          : `${(node.durationMs / 1000).toFixed(1)}s`
        : "—";

    lines.push(
      `${branch} [${node.id}] (${node.role}) · ${statusIcon(node.status, node.steers.length)} · ${wfTag}${depTag}`,
    );
    lines.push(
      `${pipe}   goal: "${clipPreview(node.goal, 96)}"`,
    );
    lines.push(
      `${pipe}   metrics: step ${node.currentStep}/${stepCap(node.maxSteps)} · ${node.totalToolCalls} tool(s) · ${node.evidenceIds.length} ev_ · ${node.totalTokens} tok · ${durTag} · ${node.currentActivity}`,
    );

    for (const steer of node.steers) {
      lines.push(
        `${pipe}   ⚡ steer #${steer.index} (${steer.mode}${steer.appliedAtStep ? ` @ step ${steer.appliedAtStep}` : " · queued"}): "${clipPreview(steer.prompt, 88)}"`,
      );
    }

    const recentSteps = node.stepsLog.slice(-6);
    recentSteps.forEach((st, sIdx) => {
      const isLastStep = sIdx === recentSteps.length - 1;
      const sBranch = isLastStep ? "└─" : "├─";
      const sPipe = isLastStep ? "  " : "│ ";
      const stDur = st.durationMs !== null ? ` (${st.durationMs}ms)` : " (live)";
      lines.push(
        `${pipe}   ${sBranch} step ${st.step} [turn ${st.turnNumber} · ${st.phase}]${stDur}`,
      );
      if (st.reasoningPreview) {
        lines.push(`${pipe}   ${sPipe}   ◈ thought: ${st.reasoningPreview}`);
      }
      for (const d of st.steersApplied) {
        lines.push(
          `${pipe}   ${sPipe}   ⚡ applied steer: "${clipPreview(d, 80)}"`,
        );
      }
      for (const tool of st.tools) {
        const tIcon =
          tool.status === "running"
            ? "▸"
            : tool.status === "ok"
              ? "✓"
              : "✗";
        const tDur =
          tool.durationMs !== null ? ` ${tool.durationMs}ms` : " running…";
        const evChip =
          tool.evidenceIds.length > 0
            ? ` ⟦${tool.evidenceIds.map((e) => e.slice(0, 12)).join(", ")}⟧`
            : "";
        lines.push(
          `${pipe}   ${sPipe}   ${tIcon} ${tool.displayTool}${tool.argsSummary ? `(${tool.argsSummary})` : ""}${tDur}${evChip}`,
        );
      }
    });

    if (node.evidenceIds.length > 0) {
      lines.push(
        `${pipe}   ev_: ${node.evidenceIds.map((id) => id.slice(0, 16)).join(", ")}`,
      );
    }
  });

  if (snap.edges.length > 0) {
    lines.push(
      `Edges: ${snap.edges.map((e) => `${e.from} ──(${e.kind})──► ${e.to}`).join("  ·  ")}`,
    );
  }
  return lines.join("\n");
};

/**
 * Render a detailed step-by-step forensic inspection of a single subagent node (`inspect <id>`).
 */
export const renderSubagentInspector = (node: SubagentNodeSnapshot): string => {
  const wfTag = node.workflow ? `/${node.workflow}` : "custom";
  const lines: string[] = [
    `╔══ SUBAGENT INSPECTOR · ${node.id} (${node.role}) · ${statusIcon(node.status, node.steers.length)} ══╗`,
    `  workflow   ${wfTag} · mode=${node.mode} · parent=${node.parentId}${node.dependsOn.length > 0 ? ` · depends_on=[${node.dependsOn.join(", ")}]` : ""}`,
    `  goal       ${node.goal}`,
    `  activity   ${node.currentActivity}`,
    `  progress   step ${node.currentStep}/${stepCap(node.maxSteps)} (${node.totalSteps} total steps across ${node.turnsRun} turn(s)) · ${node.totalToolCalls} tool calls · ${node.totalTokens} tokens`,
    `  evidence   ${node.evidenceIds.length > 0 ? node.evidenceIds.join(", ") : "none"}`,
  ];
  if (node.unknownIds.length > 0) {
    lines.push(`  unknowns   ${node.unknownIds.join(", ")}`);
  }
  if (node.steers.length > 0) {
    lines.push(`  steers (${node.steers.length}):`);
    for (const s of node.steers) {
      lines.push(
        `    #${s.index} [${s.mode}${s.appliedAtStep ? ` @ step ${s.appliedAtStep}` : " · queued"}] ${s.prompt}`,
      );
    }
  }
  lines.push(`  step-by-step execution trace (${node.stepsLog.length}):`);
  for (const st of node.stepsLog) {
    const dur = st.durationMs !== null ? `${st.durationMs}ms` : "running";
    lines.push(
      `    • Step ${st.step} (turn ${st.turnNumber} · ${st.phase} · ${dur})`,
    );
    if (st.reasoningPreview) {
      lines.push(`      ◈ reasoning: ${st.reasoningPreview}`);
    }
    for (const t of st.tools) {
      const icon =
        t.status === "running" ? "▸" : t.status === "ok" ? "✓" : "✗";
      const evs =
        t.evidenceIds.length > 0 ? ` [${t.evidenceIds.join(", ")}]` : "";
      lines.push(
        `      ${icon} ${t.displayTool}${t.argsSummary ? `(${t.argsSummary})` : ""} (${t.durationMs ?? "…"}ms)${evs}`,
      );
      if (t.resultPreview) {
        lines.push(`        ↳ ${t.resultPreview}`);
      }
    }
    if (st.textPreview) {
      lines.push(`      ✎ output: ${st.textPreview}`);
    }
  }
  if (node.summary) {
    lines.push(`\n--- Latest Summary (${node.id}) ---\n${node.summary}`);
  }
  if (node.error) {
    lines.push(`\n--- Error (${node.id}) ---\n${node.error}`);
  }
  return lines.join("\n");
};

export const formatSubagentResult = (result: SubagentTaskResult): string => {
  const wfLabel = result.workflow ? `/${result.workflow}` : "custom";
  const steerLabel =
    result.steersCount && result.steersCount > 0
      ? `, ${result.steersCount} steer(s)`
      : "";
  const idLabel = result.id ? `${result.id} · ` : "";
  const header = `[omr_task subagent ${idLabel}(${wfLabel}) · ${result.steps} step(s), ${result.toolCalls} tool call(s)${steerLabel}, ${result.totalTokens} tokens]`;
  const evLine =
    result.evidenceIds.length > 0
      ? `retained_evidence_ids: ${result.evidenceIds.join(", ")}`
      : "retained_evidence_ids: none";
  const unkLine =
    result.unknownIds.length > 0
      ? `\nunknown_ids: ${result.unknownIds.join(", ")}`
      : "";
  return `${header}\n${evLine}${unkLine}\n\n${result.summary}`;
};
