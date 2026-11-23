import { appendFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, type QueuedSteerItem } from "../agent.js";
import { describeIncompleteTurn } from "../outcome.js";
import type { LaunchOptions } from "../args.js";
import { abortable } from "../concurrency.js";
import {
  STAGED_BANG_MAX_BLOCKS,
  formatBangDisplay,
  formatStagedBangContext,
  parseBangLine,
  runBangCommand,
  toStagedBangEntry,
  type StagedBangEntry,
} from "../bang.js";
import { inspectTargetMagic, type TargetMagic } from "../binaryArt.js";
import {
  ReaBroker,
  parseSessionSnapshot,
  summarizeToolCall,
  type ParsedSessionSnapshot,
  type ToolSelectionContext,
} from "../broker.js";
import { BrowserManager } from "../browser.js";
import {
  toChatImageBlock,
  type ClipboardImageAttachment,
} from "../clipboard.js";
import {
  BUILTIN_COMMAND_KEYS,
  mergeCommands,
  type Command,
} from "../commands.js";
import {
  resolveCompactionSettings,
  resolveThresholdTokens,
  type CompactionSettings,
  type ContextUsage,
} from "../compaction.js";
import {
  discoverCustomCommands,
  type CustomCommandSpec,
} from "../customCommands.js";
import type { Dashboard } from "../dashboard.js";
import { JournalTailer } from "../journal.js";
import type { ChatImageBlock, ChatMessage, ModelPort } from "../model.js";
import type { ModelConfig } from "../modelConfig.js";
import { findProfile, type OmrProfile } from "../profiles.js";
import {
  autonomousWorkflowNote,
  matchWorkflowsForInput,
  systemPrompt,
  turnContextNote,
} from "../prompts.js";
import {
  Rea,
  errorMessage,
  type ReaConnectOptions,
  type ReaPort,
} from "../rea.js";
import { normalized, renderOpen } from "../render.js";
import {
  readOperatorDirective,
  readProjectInstructions,
  saveCodeBlockToDisk,
  saveSessionHistory,
  stripInternalPromptNotes,
  writeOmrMeta,
  type ProjectInstructions,
  type SessionInfo,
} from "../session.js";
import { SubagentRunner, formatSubagentResult } from "../subagent.js";
import { asArray, asRecord, asString } from "../values.js";
import { extractPromptMentions } from "../vision.js";
import { ModelController } from "./modelController.js";
import { resolveModelCapabilities } from "../capabilities.js";
import type { OutputSink } from "./output.js";
import { SessionRuntime, type EvidenceOrigin } from "./sessionRuntime.js";
import {
  describeCompaction,
  errorMessageOf,
  formatDurationShort,
  toolTimeoutMs,
} from "./utils.js";

export interface OmrRuntimeDeps {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly envSources?: readonly string[] | undefined;
  readonly sessionsRootDir?: string | undefined;
  readonly connectRea?:
    | ((
        sessionDir: string,
        env: NodeJS.ProcessEnv,
        sources: string[],
        options: ReaConnectOptions,
      ) => Promise<ReaPort>)
    | undefined;
  readonly createModelClient?:
    | ((config: ModelConfig) => ModelPort)
    | undefined;
  readonly writeStdout?: ((text: string) => void) | undefined;
  readonly writeStderr?: ((text: string) => void) | undefined;
  readonly persistSessionHistory?: typeof saveSessionHistory | undefined;
  readonly onExecutionStore?: ((store: import("../execution.js").ExecutionStore) => void) | undefined;
}

export class OmrContext {
  readonly opts: LaunchOptions;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly sources: string[];
  readonly sessionsRootDir: string | undefined;
  readonly output: OutputSink;
  readonly modelController: ModelController;
  runtime: SessionRuntime;
  get browserManager(): BrowserManager { return this.runtime.browser; }
  get subagentRunner(): SubagentRunner { return this.runtime.workers; }
  get session(): SessionInfo { return this.runtime.session; }
  get journalTailer(): JournalTailer { return this.runtime.journal; }
  get currentTarget(): string | null { return this.runtime.target; }
  set currentTarget(target: string | null) { this.runtime.setTarget(target); }
  get rea(): ReaPort | null { return this.runtime.rea; }
  set rea(rea: ReaPort | null) { this.runtime.rea = rea; }
  get broker(): ReaBroker | null { return this.runtime.broker; }
  set broker(broker: ReaBroker | null) { this.runtime.broker = broker; }

  compactionSettings: CompactionSettings;
  currentMagic: TargetMagic | null;
  activeProfile: OmrProfile | null = null;
  operatorDirective: string | null;
  agentsMdEnabled: boolean;
  customCommands: CustomCommandSpec[] = [];
  readonly stagedBangEntries: StagedBangEntry[] = [];
  readonly stagedImages: ClipboardImageAttachment[] = [];

  agent: Agent | null = null;
  dashboard: Dashboard | null = null;
  activeAbort: AbortController | null = null;
  interruptingForSteer = false;
  exiting = false;
  private readonly preAgentSteerQueue: QueuedSteerItem[] = [];

  targetOpened = false;
  targetOpenFailedPath: string | null = null;
  boundProvider: string | null = null;
  retainedEvidenceCount = 0;
  retainedUnknownCount = 0;
  readonly evidenceSeen = new Set<string>();
  lastEvidenceId: string | null = null;
  lastUserPrompt = "";
  lastAssistantText = "";
  lastSavedScriptPath: string | null = null;
  lastTps: number | null = null;
  lastTtftMs: number | null = null;

  private readyPromise: Promise<void> | null = null;
  private openingPromise: Promise<void> | null = null;
  private booting = false;
  private opening = false;
  private readonly connectReaFn: (
    sessionDir: string,
    env: NodeJS.ProcessEnv,
    sources: string[],
    options: ReaConnectOptions,
  ) => Promise<ReaPort>;
  private readonly persistHistoryFn: typeof saveSessionHistory;
  private operationSignal: AbortSignal | undefined;
  private readonly onExecutionStore: OmrRuntimeDeps["onExecutionStore"];

  constructor(params: {
    readonly opts: LaunchOptions;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly sources: string[];
    readonly sessionsRootDir?: string | undefined;
    readonly output: OutputSink;
    readonly session: SessionInfo;
    readonly currentTarget: string | null;
    readonly currentMagic: TargetMagic | null;
    readonly deps?: OmrRuntimeDeps | undefined;
  }) {
    this.opts = params.opts;
    this.cwd = params.cwd;
    this.env = params.env;
    this.sources = params.sources;
    this.sessionsRootDir = params.sessionsRootDir;
    this.output = params.output;
    this.runtime = new SessionRuntime(params.session, this.env, (runtime) => this.createSubagentRunner(runtime), params.currentTarget, this.cwd);
    this.configureInvestigation(this.runtime);
    this.onExecutionStore = params.deps?.onExecutionStore;
    this.onExecutionStore?.(this.runtime.events);
    this.currentMagic = params.currentMagic;
    this.connectReaFn =
      params.deps?.connectRea ??
      ((dir, env, src, opt) => Rea.connect(dir, env, src, opt));
    this.persistHistoryFn =
      params.deps?.persistSessionHistory ?? saveSessionHistory;

    this.modelController = new ModelController(
      this.env,
      this.opts.noModel,
      this.opts.model,
      this.output,
      {
        getCompactionSettings: () => this.compactionSettings,
        setCompactionSettings: (next) => {
          this.compactionSettings = next;
        },
        onModelUpdated: async () => {
          this.ensureAgentInitialized();
          await this.persistMeta();
        },
      },
      params.deps?.createModelClient,
    );

    this.compactionSettings = resolveCompactionSettings(
      this.env,
      this.modelController.storedModelConfig,
    );
    this.operatorDirective = readOperatorDirective(this.cwd, this.session.dir);
    this.agentsMdEnabled = !/^(?:0|off|false|no)$/i.test(
      (this.env["OMR_AGENTS_MD"] ?? "").trim(),
    );
    this.reloadCustomCommands();

    if (this.opts.profile) {
      const initialProfile = findProfile(this.opts.profile);
      if (initialProfile) {
        this.activateProfile(initialProfile);
      }
    }

  }

  private createSubagentRunner(runtime: SessionRuntime): SubagentRunner {
    runtime.usage.setLimitProvider(() => this.modelController.modelInfo?.config.budgetTokens ?? null);
    return new SubagentRunner({
      getModel: (id) => {const client=this.modelController.buildActiveClient();return client ? runtime.model(client, `${runtime.id}:${id ?? "worker"}`) : null;},
      getBroker: async () => {
        if (this.runtime !== runtime) throw new Error("Worker belongs to a closed session runtime");
        await this.ensureConnected();
        if (this.currentTarget) await this.ensureTargetOpen();
        if (!this.broker) throw new Error("REA broker is not connected");
        return this.broker;
      },
      getTarget: () => runtime.target,
      getTargetFormat: () => this.runtime === runtime ? this.currentMagic?.label ?? null : null,
      getSessionDir: () => runtime.session.dir,
      getBinding: () => runtime.binding,
      progressEpoch: () => runtime.progress.epoch,
      beforeStep: signal => runtime.investigation.refresh({signal}).then(()=>{}),
      stepContext: () => [runtime.investigation.note(),runtime.task.contextNote(3000),"[read-only worker: keep the pinned target; report material gaps to the supervisor instead of changing target or mutating Unknown heads]"].filter(Boolean).join("\n\n"),
      turnContext: () => [runtime.progress.note(), runtime.evidenceNote()].filter(Boolean).join("\n\n") || null,
      withTargetLease: async (binding, work, signal) => {
        await this.ensureConnected();
        if (this.currentTarget) await this.ensureTargetOpen();
        return runtime.withTargetLease(binding, work, signal);
      },
      historyCheckpoint: (scope, messages, reason) => runtime.events.captureConversation(`${runtime.id}:${scope}`, messages, reason),
      archiveProjection: input => runtime.archive.project(input),
      trace: async (scope, type, data) => { await runtime.events.append(type, {scope: `${runtime.id}:${scope}`, ...data}); },
      onProgress: (msg) => { if (this.runtime === runtime) this.output.ui?.setBusy(msg); },
      onEvidenceCollected: (evidenceIds) => {
        if (this.runtime !== runtime) return;
        for (const id of evidenceIds) {
          this.evidenceSeen.add(id);
          this.lastEvidenceId = id;
        }
      },
    });
  }

  get modelId(): string {
    return this.modelController.modelId;
  }

  private configureInvestigation(runtime: SessionRuntime): void {
    runtime.setTargetSelector(async (path, signal) => {
      if (this.runtime !== runtime) throw new Error("Target selection belongs to a replaced runtime");
      await this.selectTarget(path, signal); await this.persistMeta(path);
    });
    const changed = (): void => {if(this.runtime === runtime && !this.exiting)void this.syncLocalStatus().catch(()=>{});};
    runtime.investigation.onChange(changed);
    runtime.events.observe(({event,replayed})=>{if(!replayed&&event.type.startsWith("usage."))changed();});
  }

  allCommands(): readonly Command[] {
    return mergeCommands(this.customCommands);
  }

  reloadCustomCommands(): CustomCommandSpec[] {
    this.customCommands = discoverCustomCommands(
      this.cwd,
      this.env,
      BUILTIN_COMMAND_KEYS,
    );
    this.output.ui?.setCommands(this.allCommands());
    return this.customCommands;
  }

  activateProfile(profile: OmrProfile | null): void {
    this.activeProfile = profile;
    if (!profile) return;
    if (this.broker) {
      this.broker.promoteTools(profile.stickyTools);
    }
    if (!this.opts.noModel && this.modelController.modelInfo) {
      try {
        this.modelController.applyEffortSelection(profile.effort, false);
      } catch {
        // Ignore if model is unconfigured.
      }
    }
  }

  stageBangEntry(entry: StagedBangEntry): void {
    if (this.stagedBangEntries.length >= STAGED_BANG_MAX_BLOCKS) {
      this.stagedBangEntries.shift();
    }
    this.stagedBangEntries.push(entry);
  }

  consumeStagedBangContext(): string | null {
    if (this.stagedBangEntries.length === 0) return null;
    const text = formatStagedBangContext(this.stagedBangEntries);
    this.stagedBangEntries.length = 0;
    return text;
  }

  stageImage(attachment: ClipboardImageAttachment): void {
    if (this.output.ui) {
      this.output.ui.stageImageAttachment(attachment);
      return;
    }
    if (this.stagedImages.length >= 6) {
      this.stagedImages.shift();
    }
    this.stagedImages.push(attachment);
  }

  listStagedImages(): readonly ClipboardImageAttachment[] {
    return this.output.ui
      ? this.output.ui.getStagedImages()
      : this.stagedImages;
  }

  clearStagedImages(index?: number): number {
    if (this.output.ui) {
      return this.output.ui.clearStagedImages(index);
    }
    if (typeof index === "number" && Number.isFinite(index) && index >= 1) {
      if (index > this.stagedImages.length) return 0;
      this.stagedImages.splice(index - 1, 1);
      return 1;
    }
    const count = this.stagedImages.length;
    this.stagedImages.length = 0;
    return count;
  }

  consumeStagedImageBlocks(): ChatImageBlock[] {
    const fromUi = this.output.ui ? this.output.ui.consumeStagedImages() : [];
    const fromCtx = this.stagedImages.splice(0, this.stagedImages.length);
    return [...fromUi, ...fromCtx].map(toChatImageBlock);
  }

  async executeBangLine(rawLine: string): Promise<boolean> {
    const bang = parseBangLine(rawLine);
    if (!bang) return false;
    if (bang.kind === "clear") {
      const count = this.stagedBangEntries.length;
      this.stagedBangEntries.length = 0;
      this.output.commandResult(
        "bang",
        { cleared: count },
        this.output.i18n.t("runtime.shellCleared", { count }),
      );
      return true;
    }
    if (bang.kind === "inspect") {
      if (this.stagedBangEntries.length === 0) {
        this.output.commandResult(
          "bang",
          { staged: [] },
          this.output.i18n.t("runtime.shellEmpty"),
        );
        return true;
      }
      const text = this.stagedBangEntries
        .map(
          (entry, idx) =>
            `${idx + 1}. $ ${entry.command} (exit ${entry.exitCode ?? "?"} · ${entry.output.length} chars)`,
        )
        .join("\n");
      this.output.commandResult(
        "bang",
        { staged: this.stagedBangEntries },
        text,
      );
      return true;
    }

    this.output.ui?.addUser(rawLine);
    this.output.ui?.setBusy(this.output.i18n.t("runtime.shellRunning", { command: bang.command }));
    const abort = new AbortController();
    this.activeAbort = abort;
    try {
      const outcome = await this.runtime.events.invoke({backend: "shell", tool: "bang", args: {command: bang.command, cwd: this.cwd}, readOnly: false, binding: this.runtime.binding}, () => runBangCommand(bang.command, {
        cwd: this.cwd,
        env: this.env,
        signal: abort.signal,
      }), abort.signal);
      if (bang.attachToContext) {
        this.stageBangEntry(toStagedBangEntry(outcome));
      }
      const display = formatBangDisplay(outcome, bang.attachToContext);
      this.output.recordOutcome({
        status: abort.signal.aborted ? "cancelled" : outcome.exitCode === 0 && !outcome.timedOut ? "completed" : "failed",
        finishReason: outcome.timedOut ? "timeout" : String(outcome.exitCode),
      });
      this.output.commandResult(
        bang.attachToContext ? "!!" : "!",
        {
          command: outcome.command,
          exit_code: outcome.exitCode,
          timed_out: outcome.timedOut,
          attached_to_context: bang.attachToContext,
          duration_ms: outcome.durationMs,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
        },
        display,
      );
    } finally {
      this.activeAbort = null;
      this.output.ui?.setBusy(null);
    }
    return true;
  }

  activeProjectInstructions(): ProjectInstructions | null {
    return this.agentsMdEnabled ? readProjectInstructions(this.cwd) : null;
  }

  currentToolContext(): ToolSelectionContext {
    return {
      targetPath: this.currentTarget,
      targetFormat: this.currentMagic?.label ?? null,
    };
  }

  buildDynamicSystemPrompt(): string {
    return systemPrompt({
      answerLanguage: this.output.i18n.answerLanguage,
      target: this.currentTarget,
      targetOpened: this.targetOpened,
      targetFormat: this.currentMagic?.label ?? null,
      boundProvider: this.boundProvider,
      evidenceCount: this.retainedEvidenceCount,
      unknownCount: this.retainedUnknownCount,
      sessionDir: this.session.dir,
      journalPath: this.session.journalPath,
      directTools: this.broker?.directNames(this.currentToolContext()) ?? [],
      operatorDirective: this.operatorDirective,
      activeProfile: this.activeProfile,
      projectInstructions: this.activeProjectInstructions(),
    });
  }

  contextSnapshot(): ContextUsage {
    if (this.agent) return this.agent.contextUsage();
    const client=this.modelController.buildActiveClient();
    const capabilities=client?.capabilities??resolveModelCapabilities(client?.model??this.modelId,client?.providerId);
    const window=this.compactionSettings.windowSource==="operator"?this.compactionSettings.contextWindow:capabilities.contextWindow;
    return {
      tokens: 0,
      window,
      percent: 0,
      thresholdTokens: resolveThresholdTokens({...this.compactionSettings,contextWindow:window}),
      source: "estimate",
      windowSource:this.compactionSettings.windowSource==="operator"?"operator":capabilities.source,
    };
  }

  contextStatus(usage: ContextUsage = this.contextSnapshot()): {
    tokens: number;
    window: number;
    percent: number;
    source: ContextUsage["source"];
    windowSource: string | undefined;
  } {
    return {
      tokens: usage.tokens,
      window: usage.window,
      percent: usage.percent,
      source: usage.source,
      windowSource: usage.windowSource,
    };
  }

  async syncMagic(targetPath: string | null): Promise<void> {
    const runtime = this.runtime;
    const magic = await inspectTargetMagic(targetPath);
    if (this.runtime !== runtime || this.currentTarget !== targetPath) return;
    this.currentMagic = magic;
    this.output.ui?.setStatus({
      target: targetPath,
      magic: this.currentMagic,
    });
  }

  async persistMeta(
    targetOverride: string | null = this.currentTarget,
  ): Promise<void> {
    try {
      await writeOmrMeta(
        this.session,
        targetOverride,
        this.modelController.modelInfo?.config.model ?? null,
      );
    } catch (error) {
      this.output.warnPersistenceOnce("meta", error);
    }
  }

  async persistHistory(
    messages: readonly ChatMessage[] = this.agent?.history ?? [],
    targetOverride: string | null = this.currentTarget,
    options?: { readonly inFlight?: boolean },
  ): Promise<void> {
    try {
      await this.runtime.events.captureConversation("primary", messages, options?.inFlight ? "checkpoint" : "save");
      await this.persistHistoryFn(
        this.session,
        messages,
        targetOverride,
        this.modelId,
        options,
      );
    } catch (error) {
      this.output.warnPersistenceOnce("history", error);
    }
  }

  async appendReport(label: string, text: string): Promise<void> {
    try {
      await appendFile(
        this.session.reportPath,
        `\n## ${new Date().toISOString()} · ${label}\n\n${text}\n`,
      );
    } catch (error) {
      this.output.warnPersistenceOnce("report", error);
    }
  }

  async switchSession(nextSession: SessionInfo, origin?: {source: SessionInfo; kind: EvidenceOrigin["kind"]}): Promise<void> {
    if (this.activeAbort) throw new Error(this.output.i18n.t("runtime.switchBusy"));
    if (this.session.dir === nextSession.dir) return;
    const previous = this.runtime;
    previous.lifecycle.abort();
    await this.readyPromise?.catch(() => {});
    await previous.workers.cancelAll();
    await previous.captureEvidence().catch((error: unknown) => this.output.warnPersistenceOnce("evidence-export", error));
    await previous.events.flush();
    await previous.task.flush();
    await previous.forge.flush();
    if (!origin || origin.source.dir === previous.session.dir) {
      await copyFile(join(previous.session.dir, "evidence-bundle.json"), join(nextSession.dir, "evidence-bundle.json")).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      await copyFile(previous.events.path, join(nextSession.dir, "execution.jsonl")).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      await copyFile(previous.usage.path, join(nextSession.dir, "usage.json")).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      await copyFile(previous.task.path, join(nextSession.dir, "task-state.json")).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    await previous.close();
    this.runtime = new SessionRuntime(nextSession, this.env, (runtime) => this.createSubagentRunner(runtime), nextSession.target, this.cwd);
    this.configureInvestigation(this.runtime);
    this.onExecutionStore?.(this.runtime.events);
    await this.runtime.setOrigin(origin?.source ?? previous.session, origin?.kind ?? "fork");
    this.readyPromise = null;
    this.openingPromise = null;
    this.targetOpened = false;
    this.targetOpenFailedPath = null;
    this.boundProvider = null;
    this.evidenceSeen.clear();
    this.retainedEvidenceCount = 0; this.retainedUnknownCount = 0;
    this.lastEvidenceId = null;
    this.operatorDirective = readOperatorDirective(this.cwd, nextSession.dir);
    this.preAgentSteerQueue.length = 0;
    this.stagedBangEntries.length = 0;
    this.stagedImages.length = 0;
    await this.syncMagic(this.currentTarget);
    this.output.emit("session.switched", {session_id: nextSession.id, runtime_id: this.runtime.id, origin: this.runtime.evidenceOrigin});
  }

  async selectTarget(target: string | null, signal?: AbortSignal): Promise<void> {
    const runtime = this.runtime;
    await runtime.targetAccess.run("write", async () => {
      if (this.runtime !== runtime) throw new Error("Session changed while target selection was queued");
      this.currentTarget = target;
      this.targetOpened = false; this.targetOpenFailedPath = null; this.boundProvider = null;
      await this.syncMagic(target);
    }, signal);
  }

  async syncLocalStatus(): Promise<void> {
    const runtime = this.runtime;
    const state = await runtime.journal.sync();
    if (this.runtime !== runtime) return;
    const investigation = runtime.investigation.read();
    this.retainedEvidenceCount = investigation.ledger.health === "live" ? investigation.ledger.evidence ?? 0 : 0;
    this.retainedUnknownCount = investigation.ledger.health === "live" ? investigation.ledger.unknownOpen ?? 0 : 0;
    if (investigation.nativeBinding.state !== "unknown") {
      this.targetOpened = investigation.nativeBinding.state === "open" && investigation.nativeBinding.path === this.currentTarget;
      this.boundProvider = investigation.nativeBinding.provider;
    }
    const usage = runtime.usage.snapshot();
    const browser = runtime.browser.context.read();
    const tab = browser.tabs.find(tab => tab.id === browser.activeTabId && tab.status !== "closed");
    const browserScope = tab ? {kind:"browser" as const,value:tab.url??tab.id,operation:"camofox_observation",observedAt:tab.capture?.observedAt??tab.lastScreenshot?.observedAt??"",historical:tab.status==="historical"} : browser.local?.status==="owned" ? {kind:"browser" as const,value:browser.local.url,operation:"local_browser",observedAt:"",historical:false} : null;

    this.output.ui?.setStatus({
      model: this.modelId,
      modelProvider: this.modelController.modelInfo?.config.providerId ?? null,
      effort: this.modelController.modelInfo?.config.reasoningEffort ?? "auto",
      compactor:
        this.compactionSettings.compactionModel ??
        (this.compactionSettings.strategy === "snapcompact"
          ? "snapcompact"
          : null),
      context: this.contextStatus(),
      target: this.currentTarget,
      magic: this.currentMagic,
      provider: this.boundProvider,
      reaConnected: Boolean(this.rea),
      reaTools: this.rea?.tools().length ?? 0,
      evidence: investigation.ledger.evidence,
      unknowns: investigation.ledger.unknownOpen,
      unknownTotal: investigation.ledger.unknownTotal,
      unknownResolved: investigation.ledger.unknownResolved,
      ledgerHealth: investigation.ledger.health,
      ledgerObservedAt: investigation.ledger.observedAt,
      analysisScope: browserScope ?? investigation.lastAnalysis,
      nativeBinding: investigation.nativeBinding.state,
      estimatedTokens: usage.estimatedTokens,
      priorUsageUnknown: usage.priorUsageUnknown,
      journal: state.counts.records,
      journalHealth: state.source,
      journalMalformed: state.malformed_records,
      tokens: usage.totalTokens,
      session: this.session.id,
    });
  }

  async applyParsedSnapshot(snap: ParsedSessionSnapshot, expectedRuntime = this.runtime): Promise<void> {
    if (this.runtime !== expectedRuntime) return;
    this.boundProvider = snap.boundProvider;
    if (snap.open && snap.path) {
      this.targetOpened = true;
      this.targetOpenFailedPath = null;
      if (this.currentTarget !== snap.path) {
        this.currentTarget = snap.path;
        await this.syncMagic(this.currentTarget);
      }
    } else if (!snap.open && this.targetOpened) {
      this.targetOpened = false;
      this.boundProvider = null;
    }

  }

  async syncBoundSessionSummary(): Promise<void> {
    const runtime = this.runtime;
    if (!this.rea || !this.targetOpened || this.booting || this.opening) {
      await this.runtime.investigation.refresh();
      await this.syncLocalStatus();
      return;
    }
    const snapshot = await this.rea
      .call("binary_session", { detail: "summary" })
      .catch(() => null);
    const parsed = parseSessionSnapshot(snapshot?.payload);
    if (this.runtime !== runtime) return;
    if (parsed) await this.applyParsedSnapshot(parsed, runtime);
    await this.runtime.investigation.refresh();
    await this.syncLocalStatus();
  }

  ensureAgentInitialized(): void {
    const rawClient = this.modelController.buildActiveClient();
    const activeClient = rawClient ? this.runtime.model(rawClient, "primary") : null;
    if (!activeClient || !this.broker) return;
    if (!this.agent) {
      this.agent = new Agent(activeClient, this.broker, {
        historyCheckpoint: (messages, reason) => this.runtime.events.captureConversation("primary", messages, reason),
        archiveProjection: input => this.runtime.archive.project(input),
        trace: async (type, data) => { await this.runtime.events.append(type, {scope: "primary", ...data}); },
        systemPrompt: () => this.buildDynamicSystemPrompt(),
        toolContext: () => this.currentToolContext(),
        compaction: () => this.compactionSettings,
        compactionModel: () => {
          try {
            const client = this.modelController.resolveCompactionModelClient();
            return client ? this.runtime.model(client, "compaction") : null;
          } catch {
            return null;
          }
        },
        turnContext: () => {
          const notes = [
            this.runtime.evidenceNote(),
            this.runtime.events.recoveryNote(),
            this.runtime.progress.note(),
            this.consumeStagedBangContext(),
            this.subagentRunner.consumeCompletedNotifications(),
          ].filter((item): item is string => Boolean(item));
          return notes.length > 0 ? notes.join("\n\n") : null;
        },
        progressEpoch: () => this.runtime.progress.epoch,
        beforeStep: async signal => {
          if (!this.rea || this.rea.isClosed) {
            signal?.throwIfAborted();
            await abortable(this.ensureConnected(), signal);
            if (this.currentTarget) await abortable(this.ensureTargetOpen(), signal);
          }
          await this.runtime.investigation.refresh({ signal });
          await this.syncLocalStatus();
        },
        stepContext: () => [this.runtime.investigation.note(),this.runtime.task.contextNote(3000),this.runtime.browser.contextNote()?.slice(0,2000)].filter(Boolean).join("\n\n"),
        reviewCompletion: () => this.runtime.investigation.completionReview(),
        ...(this.modelController.modelInfo?.config.maxSteps !== undefined
          ? { maxSteps: this.modelController.modelInfo.config.maxSteps }
          : {}),
        ...(this.modelController.modelInfo?.config.autoExtendSteps !== undefined
          ? {
              autoExtendSteps:
                this.modelController.modelInfo.config.autoExtendSteps,
            }
          : {}),
        budgetTokens: () =>
          this.runtime.usage.snapshot().budgetTokens,
      });
    } else {
      this.agent.setModel(activeClient);
      this.agent.setBroker(this.broker);
    }
    if (this.preAgentSteerQueue.length > 0) {
      const pending = this.preAgentSteerQueue.splice(
        0,
        this.preAgentSteerQueue.length,
      );
      for (const item of pending) {
        this.agent.enqueueSteer(item.text, item.images);
      }
      this.syncUiSteers();
    }
    this.modelController.modelId = this.agent.modelId;
  }

  isTurnActive(): boolean {
    return this.activeAbort !== null;
  }

  pendingSteerCount(): number {
    return (
      this.preAgentSteerQueue.length + (this.agent?.pendingSteerCount() ?? 0)
    );
  }

  pendingSteerTexts(): string[] {
    const items = [
      ...this.preAgentSteerQueue,
      ...(this.agent?.pendingSteers() ?? []),
    ];
    return items.map((item) =>
      item.images && item.images.length > 0
        ? `${item.text} [📎 ×${item.images.length}]`
        : item.text,
    );
  }

  syncUiSteers(): void {
    this.output.ui?.setQueuedSteers(this.pendingSteerTexts());
  }

  enqueueLiveSteer(
    instruction: string,
    images?: readonly ChatImageBlock[],
  ): boolean {
    const clean = instruction.trim();
    const hasImages = Boolean(images && images.length > 0);
    if (!clean && !hasImages) return false;
    if (this.agent) {
      this.agent.enqueueSteer(clean, images);
    } else {
      this.preAgentSteerQueue.push({
        text: clean || "(attached image)",
        ...(hasImages ? { images } : {}),
      });
    }
    this.syncUiSteers();
    return true;
  }

  dequeueLiveSteer(): QueuedSteerItem | null {
    const item =
      this.agent?.dequeueLastSteer() ?? this.preAgentSteerQueue.pop() ?? null;
    this.syncUiSteers();
    return item;
  }

  drainAllPendingSteers(): QueuedSteerItem[] {
    const items: QueuedSteerItem[] = [];
    if (this.preAgentSteerQueue.length > 0) {
      items.push(
        ...this.preAgentSteerQueue.splice(0, this.preAgentSteerQueue.length),
      );
    }
    if (this.agent) {
      items.push(...this.agent.drainSteerQueue());
    }
    this.syncUiSteers();
    return items;
  }

  interruptAndSteer(
    instruction?: string,
    images?: readonly ChatImageBlock[],
  ): boolean {
    if (instruction?.trim() || (images && images.length > 0)) {
      this.enqueueLiveSteer(instruction ?? "", images);
    }
    if (this.pendingSteerCount() === 0) return false;
    if (this.activeAbort) {
      this.interruptingForSteer = true;
      this.activeAbort.abort();
      return true;
    }
    return false;
  }

  async ensureConnected(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    const runtime = this.runtime;
    this.readyPromise = (async () => {
      await runtime.usage.initialize();
      await runtime.task.initialize();
      await runtime.investigation.initialize();
      await runtime.browser.context.initialize();
      this.booting = true;
      this.output.ui?.setBusy(this.output.i18n.t("runtime.startingRea"));
      if (!this.output.ui && !this.opts.json) {
        this.output.write(this.output.i18n.t("runtime.startingReaNotice"));
      }
      const connection = await this.connectReaFn(
        this.session.dir,
        this.env,
        this.sources,
        {
          toolTimeoutMs: toolTimeoutMs(this.env),
          signal: this.operationSignal ? AbortSignal.any([runtime.lifecycle.signal, this.operationSignal]) : runtime.lifecycle.signal,
          onLost: (detail) => {
            if (this.exiting || this.runtime !== runtime) return;
            this.rea = null;
            this.broker = null;
            this.readyPromise = null;
            this.openingPromise = null;
            this.targetOpened = false;
            this.boundProvider = null;
            runtime.investigation.disconnect();
            void this.syncLocalStatus().catch(() => {});
            this.output.systemNotice(
              this.output.i18n.t("runtime.reaReconnect", { detail }),
            );
          },
        },
      );
      this.rea = runtime.attachRea(connection);
      await runtime.forge.initialize();
      await this.runtime.restoreEvidence();
      for (const id of this.runtime.importedEvidenceIds) this.evidenceSeen.add(id);
      this.broker = new ReaBroker(this.rea, {
        localTools: () => runtime.localTools(),
        execution: runtime.events,
        binding: () => runtime.binding,
        browser: this.browserManager,
        currentTarget: () => this.currentTarget,
        scriptsDir: () => this.session.scriptsDir,
        runSubagent: async (args, sig, onProg) => {
          const result = await this.subagentRunner.dispatchMetaTool(
            args,
            sig,
            onProg,
          );
          for (const id of result.evidenceIds) {
            this.evidenceSeen.add(id);
            this.lastEvidenceId = id;
          }
          return result;
        },
        onSessionMutation: (event) => {
          if (this.runtime !== runtime) return;
          if (event.kind === "open") {
            this.currentTarget = event.path;
            this.targetOpened = true;
            this.targetOpenFailedPath = null;
            void this.syncMagic(this.currentTarget).then(() =>
              this.syncBoundSessionSummary(),
            );
            void this.persistMeta(this.currentTarget);
          } else if (event.kind === "close") {
            this.targetOpened = false;
            this.boundProvider = null;
            void this.syncLocalStatus();
          } else if (event.kind === "snapshot") {
            void this.applyParsedSnapshot(event.snapshot, runtime).then(() =>
              this.syncLocalStatus(),
            );
          } else if (event.kind === "reset") {
            this.evidenceSeen.clear();
            if (!event.retainedTarget) {
              this.targetOpened = false;
              this.boundProvider = null;
            }
            void this.syncBoundSessionSummary();
          }
        },
      });
      if (this.activeProfile) {
        this.broker.promoteTools(this.activeProfile.stickyTools);
      }
      if (this.agent) {
        this.broker.restoreSticky(this.agent.history);
      }
      await this.modelController.whenCapabilitiesReady();
      this.ensureAgentInitialized();
      this.booting = false;
      this.output.ui?.setBusy(null);
      runtime.investigation.startAutomaticRefresh();
      await runtime.investigation.refresh();
      await this.syncLocalStatus();
      if (this.output.ui && !this.opts.noModel) {
        void this.modelController.triggerProvidersRefresh(false).catch(() => {});
      }
      this.output.emit("rea.ready", {
        tools: connection.tools().length,
        model: this.modelId,
      });
    })().catch(async (error: unknown) => {
      await runtime.rea?.close().catch(() => {});
      runtime.rea = null; runtime.broker = null;
      this.readyPromise = null;
      this.booting = false;
      this.output.ui?.setBusy(null);
      const message = errorMessageOf(error);
      this.output.fail(this.output.i18n.t("runtime.reaFailed", { detail: message }));
      throw error;
    });
    return this.readyPromise;
  }

  async ensureTargetOpen(): Promise<void> {
    await this.ensureConnected();
    const connection = this.rea;
    if (!connection || !this.currentTarget || this.targetOpened) return;
    if (this.targetOpenFailedPath === this.currentTarget) return;
    if (this.currentMagic?.label === "Directory Target") return;
    if (this.openingPromise) return this.openingPromise;
    this.openingPromise = (async () => {
      this.opening = true;
      this.output.ui?.setBusy(this.output.i18n.t("runtime.openingTarget"));
      if (!this.output.ui && !this.opts.json) {
        this.output.write(this.output.i18n.t("runtime.openingTargetNotice"));
      }
      try {
        const opened = await connection.call("open_binary", {
          path: this.currentTarget,
        });
        const problem = opened.isError
          ? (errorMessage(opened.payload) ?? opened.text)
          : null;
        if (problem) {
          this.targetOpenFailedPath = this.currentTarget;
          this.output.fail(this.output.i18n.t("runtime.targetFailed", { target: this.currentTarget, detail: problem }));
        } else {
          this.targetOpened = true;
          this.targetOpenFailedPath = null;
          if (this.opts.json) {
            this.output.emit("target.open", { payload: opened.payload });
          } else if (!this.output.ui) {
            this.output.write(renderOpen(opened.payload, this.output.i18n));
          }
        }
      } finally {
        this.opening = false;
        this.openingPromise = null;
        this.output.ui?.setBusy(null);
      }
      await this.syncBoundSessionSummary();
    })();
    return this.openingPromise;
  }

  async reaCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    isError: boolean;
    text: string;
    payload: unknown;
    durationMs: number;
    problem: string | null;
  }> {
    if (!this.rea) {
      return {
        isError: true,
        text: "REA is not connected yet",
        payload: null,
        durationMs: 0,
        problem: "REA is not connected yet",
      };
    }
    try {
      const result = await this.rea.call(name, args);
      const problem = result.isError
        ? (errorMessage(result.payload) ?? result.text)
        : null;
      return { ...result, problem };
    } catch (error) {
      const message = errorMessageOf(error);
      return {
        isError: true,
        text: message,
        payload: null,
        durationMs: 0,
        problem: message,
      };
    }
  }

  async resolveEvidenceLookupId(
    query: string,
  ): Promise<{ id: string | null; error?: string }> {
    const trimmed = query
      .trim()
      .replace(/^⟦|⟧$/g, "")
      .replace(/….*$/, "");
    if (
      trimmed.toLowerCase() === "last" ||
      trimmed.toLowerCase() === "latest"
    ) {
      if (this.lastEvidenceId) return { id: this.lastEvidenceId };
      const summary = await this.reaCall("get_evidence_bundle", {
        detail: "summary",
        limit: 1,
      });
      if (summary.problem) return { id: null, error: summary.problem };
      const record = asRecord(normalized(summary.payload));
      const latest = asArray(record?.["records"])
        .map((item) => asString(asRecord(item)?.["evidence_id"]))
        .find(Boolean);
      return latest
        ? { id: latest }
        : { id: null, error: "no retained Evidence records yet" };
    }
    if (/^ev_[0-9a-f]{64}$/.test(trimmed)) return { id: trimmed };
    const normalizedPrefix = trimmed.startsWith("ev_")
      ? trimmed
      : `ev_${trimmed}`;
    const summary = await this.reaCall("get_evidence_bundle", {
      detail: "summary",
      limit: 200,
    });
    if (summary.problem) return { id: null, error: summary.problem };
    const record = asRecord(normalized(summary.payload));
    const matches = asArray(record?.["records"])
      .map((item) => asString(asRecord(item)?.["evidence_id"]))
      .filter((id) => id.startsWith(normalizedPrefix));
    if (matches.length === 1) return { id: matches[0]! };
    if (matches.length > 1) {
      return {
        id: null,
        error: `ambiguous Evidence prefix "${trimmed}" matches ${matches.length} records:\n  ${matches.slice(0, 5).join("\n  ")}`,
      };
    }
    return {
      id: null,
      error: `no retained Evidence record matching "${trimmed}"`,
    };
  }

  async startDashboard(): Promise<void> {
    try {
      if (!this.dashboard) {
        const { Dashboard: DashboardImpl } = await import("../dashboard.js");
        this.dashboard = new DashboardImpl(
          this.session,
          () => this.currentTarget,
          this.journalTailer,
          () => this.runtime.investigation.read(),
        );
      }
      const url = await this.dashboard.start();
      if (this.opts.json) this.output.emit("dashboard", { url });
      else if (this.output.ui) {
        this.output.ui.showOutput(
          "dashboard",
          this.output.i18n.t("runtime.dashboardStarted", { url }),
        );
      } else {
        this.output.write(this.output.i18n.t("runtime.dashboard", { url }));
      }
    } catch (error) {
      this.output.fail(this.output.i18n.t("runtime.dashboardFailed", { detail: errorMessageOf(error) }));
    }
  }

  async shutdown(outcome: string): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    this.activeAbort?.abort();
    this.runtime.lifecycle.abort();
    await this.subagentRunner.cancelAll();
    await this.runtime.captureEvidence().catch((error: unknown) => this.output.warnPersistenceOnce("evidence-export", error));
    this.output.ui?.stop();
    await this.runtime.close().catch((error: unknown) => this.output.warnPersistenceOnce("runtime-close", error));
    if (this.dashboard) await this.dashboard.stop().catch(() => {});
    this.output.emit("session.end", {
      outcome,
      session_dir: this.session.dir,
    });
    if (!this.output.ui && !this.opts.json) {
      this.output.write(this.output.i18n.t("runtime.session", { path: this.session.dir }));
    }
  }

  async withOperationSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const previous = this.operationSignal; this.operationSignal = signal;
    const abort = (): void => { this.activeAbort?.abort(signal.reason); };
    signal.addEventListener("abort", abort, {once: true});
    try {signal.throwIfAborted();return await work();}
    finally {signal.removeEventListener("abort", abort);this.operationSignal = previous;}
  }

  async runTurn(
    input: string,
    label: string,
    options?: {
      autoSaveScriptPrefix?: string;
      images?: readonly ChatImageBlock[];
    },
  ): Promise<void> {
    const ui = this.output.ui;
    const mentions = await extractPromptMentions(
      input,
      this.cwd,
      this.session.dir,
    );
    const stagedBlocks = this.consumeStagedImageBlocks();
    const mentionBlocks = mentions.images.map(toChatImageBlock);
    const turnImages: ChatImageBlock[] = [
      ...(options?.images ?? []),
      ...stagedBlocks,
      ...mentionBlocks,
    ];
    if (mentions.images.length > 0) {
      const labels = mentions.images.map((img) => img.label).join(", ");
      if (ui) ui.addSystem(this.output.i18n.t("runtime.mentionImage", { labels }));
      else if (!this.opts.json) {
        this.output.write(this.output.i18n.t("runtime.imageAttached", { labels }));
      }
    }
    const effectiveInput = mentions.contextAppendix
      ? `${input}\n\n${mentions.contextAppendix}`
      : input;

    if (this.activeAbort) {
      // Queue into live steering instead of dropping or rejecting the operator's message.
      this.enqueueLiveSteer(
        effectiveInput,
        turnImages.length > 0 ? turnImages : undefined,
      );
      return;
    }
    if (!this.modelController.modelInfo || this.opts.noModel) {
      const reason = this.opts.noModel
        ? "model disabled (--no-model)"
        : `no model configured: ${this.modelController.modelError ?? "unknown error"}\nTip: press Alt+M or run /model to inspect 33+ supported providers.`;
      this.output.fail(reason);
      return;
    }
    this.activeAbort = new AbortController();
    if (this.operationSignal?.aborted) this.activeAbort.abort(this.operationSignal.reason);
    const signal = this.activeAbort.signal;
    this.interruptingForSteer = false;
    const started = Date.now();
    const evidenceBefore = this.evidenceSeen.size;
    let streamedPlainLineOpen = false;
    let streamedAny = false;
    let activeToolLabel = "tool";
    let wasInterruptedForSteer = false;
    ui?.setBusy(this.output.i18n.t("runtime.thinking"));

    try {
      try {
        await abortable(this.ensureConnected(), signal);
        if (this.currentTarget) await abortable(this.ensureTargetOpen(), signal);
      } catch (error) {
        if (signal.aborted) throw error;
        return;
      }
      this.ensureAgentInitialized();
      if (!this.agent) {
        this.output.fail(this.output.i18n.t("runtime.noModel", { detail: this.modelController.modelError ?? "unknown error" }));
        return;
      }
      this.lastUserPrompt = input;
      await abortable(this.runtime.investigation.discover(stripInternalPromptNotes(input)).catch(() => {}), signal);
      await abortable(this.runtime.assertRecoveryReady(), signal);
      const taskGoal=this.opts.goal ?? stripInternalPromptNotes(input);
      await abortable(this.runtime.task.initializeGoal(taskGoal), signal);
      const turn = await this.agent.run(
        effectiveInput,
        {
          onAssistantStart: () => ui?.beginAssistant(),
          onReasoningDelta: (thought) => {
            ui?.appendReasoning(thought);
          },
          onAssistantDelta: (delta) => {
            streamedAny = true;
            if (ui) {
              ui.appendAssistant(delta);
            } else if (!this.opts.json) {
              this.output.writeRaw(delta);
              streamedPlainLineOpen = !delta.endsWith("\n");
            }
          },
          onAssistantEnd: (text) => {
            ui?.endAssistant(text);
            if (!ui && !this.opts.json && streamedPlainLineOpen) {
              this.output.writeRaw("\n");
              streamedPlainLineOpen = false;
            }
          },
          onStreamReset: () => {
            ui?.resetActiveStream();
          },
          onSteerApplied: (directives, step) => {
            this.syncUiSteers();
            for (const directive of directives) {
              ui?.addUser(`✻ [steer] ${directive}`);
            }
            if (this.opts.json) {
              this.output.emit("turn.steered", {
                step,
                directives,
              });
            }
          },
          onCheckpoint: async () => {
            await this.persistHistory(this.agent!.history, this.currentTarget, {
              inFlight: true,
            });
            await this.runtime.captureEvidence().catch((error: unknown) => this.output.warnPersistenceOnce("evidence-export", error));
          },
          onStepBudgetExtended: (notice) => {
            const text = `step budget ${notice.step} reached while making progress · auto-extending to ${notice.newBudget} (${notice.extension}/${notice.maxExtensions})`;
            if (ui) ui.addSystem(text);
            else if (!this.opts.json) this.output.writeError(text);
            if (this.opts.json)
              this.output.emit("turn.budget_extended", { ...notice });
          },
          onBudgetReached: (notice) => {
            const text = `token budget reached (${notice.usedTokens} / ${notice.budgetTokens} tokens) · use /budget <tokens> or /budget off to continue`;
            if (ui) ui.addSystem(text);
            else if (!this.opts.json) this.output.writeError(text);
            if (this.opts.json)
              this.output.emit("turn.budget_reached", { ...notice });
          },
          onNetworkStatus: (notice) => {
            ui?.setNetworkStatus(notice);
            if (notice.state === "restored") {
              ui?.setBusy(this.output.i18n.t("runtime.networkBack"));
              if (!ui && !this.opts.json) {
                this.output.writeError(
                  this.output.i18n.t("runtime.networkRestored", { target: notice.target, latency: notice.latencyMs !== null ? ` · ${notice.latencyMs}ms` : "" }),
                );
              }
            } else {
              ui?.setBusy(
                this.output.i18n.t("runtime.networkPing", { attempt: notice.attempt, target: notice.target }),
              );
              if (
                !ui &&
                !this.opts.json &&
                notice.attempt === 1 &&
                notice.state === "offline"
              ) {
                this.output.writeError(
                  this.output.i18n.t("runtime.networkOffline", { reason: notice.reason, target: notice.target }),
                );
              }
            }
            if (this.opts.json) {
              this.output.emit("network.status", { ...notice });
            }
          },
          onCompactionStart: (strategy) =>
            ui?.setBusy(this.output.i18n.t("runtime.compacting", { strategy })),
          onCompaction: (report) => {
            const text = describeCompaction(report);
            if (ui) ui.addSystem(text);
            else if (this.opts.json)
              this.output.emit("context.compacted", { ...report });
            else this.output.write(`  ${text}`);
          },
          onContext: (usage) =>
            ui?.setStatus({ context: this.contextStatus(usage) }),
          onSpeed: (speed) => {
            this.lastTps = speed.tps;
            this.lastTtftMs = speed.ttftMs;
            ui?.setStatus({
              tps: speed.tps,
              tpsLive: speed.live,
              ttftMs: speed.ttftMs,
            });
          },
          onRetry: (notice) => {
            const text = `model ${notice.reason} · retry ${notice.attempt}/${notice.maxRetries} in ${(notice.delayMs / 1000).toFixed(1)}s`;
            ui?.setBusy(text);
            if (!ui && !this.opts.json) this.output.writeError(text);
            if (this.opts.json) this.output.emit("model.retry", { ...notice });
          },
          onToolProgress: (_callId, message) => {
            ui?.setBusy(`${activeToolLabel} · ${message.slice(0, 60)}`);
          },
          onToolStart: (callId, name, args) => {
            if (!ui && !this.opts.json && streamedPlainLineOpen) {
              this.output.writeRaw("\n");
              streamedPlainLineOpen = false;
            }
            const { displayTool, summary } = summarizeToolCall(name, args);
            activeToolLabel = displayTool;
            ui?.setBusy(this.output.i18n.t("runtime.toolRunning", { tool: displayTool }));
            ui?.toolStart(callId, name, args);
            if (!this.opts.json && !ui) {
              this.output.write(
                `  ▸ ${displayTool}${summary ? ` (${summary})` : ""}`,
              );
            }
            if (this.opts.json) {
              this.output.emit("tool.start", {
                call_id: callId,
                tool: name,
                arguments: args,
              });
            }
          },
          onToolEnd: (callId, outcome) => {
            for (const id of outcome.evidenceIds) {
              this.evidenceSeen.add(id);
              this.lastEvidenceId = id;
            }
            ui?.toolEnd(
              callId,
              outcome.tool,
              !outcome.isError,
              outcome.durationMs,
              outcome.evidenceIds,
            );
            void this.syncLocalStatus().catch(()=>{});
            if (!this.opts.json && !ui) {
              const evSuffix =
                outcome.evidenceIds.length > 0
                  ? ` [${outcome.evidenceIds.map((id) => id.slice(0, 12)).join(", ")}]`
                  : "";
              this.output.write(
                `  ${outcome.isError ? "✗" : "✓"} ${outcome.tool} ${outcome.durationMs}ms${evSuffix}`,
              );
            }
            if (this.opts.json) {
              this.output.emit("tool.end", {
                call_id: callId,
                tool: outcome.tool,
                ok: !outcome.isError,
                duration_ms: outcome.durationMs,
                evidence_ids: outcome.evidenceIds,
              });
            }
          },
          onStep: (step) => ui?.setBusy(this.output.i18n.t("runtime.step", { step })),
          onUsage: (_turnUsage, totalTokens) =>
            ui?.setStatus({ tokens: totalTokens }),
        },
        signal,
        turnImages.length > 0 ? turnImages : undefined,
      );

      ui?.setBusy(null);
      const elapsedMs = Date.now() - started;
      this.output.recordOutcome(turn);
      this.output.emit("turn.result", {
        status: turn.status, finish_reason: turn.finishReason,
        steps: turn.steps, tool_calls: turn.toolCalls, usage: turn.usage, duration_ms: elapsedMs,
      });
      if (turn.status !== "completed" && !turn.aborted) {
        this.output.systemNotice(this.output.i18n.t("runtime.turnIncomplete", { status: turn.status, reason: turn.finishReason ? ` (${turn.finishReason})` : "", detail: describeIncompleteTurn(turn.finishReason) }));
      }
      const newEvidence = Math.max(0, this.evidenceSeen.size - evidenceBefore);
      wasInterruptedForSteer = this.interruptingForSteer;

      if (turn.aborted) {
        if (
          ui?.currentNetworkStatus &&
          ui.currentNetworkStatus.state !== "restored"
        ) {
          ui.setNetworkStatus(null);
        }
        if (wasInterruptedForSteer) {
          ui?.addSystem(
            this.output.i18n.t("runtime.steered", { time: formatDurationShort(elapsedMs) }),
          );
        } else if (ui) {
          ui.addSystem(
            this.output.i18n.t("runtime.cancelled", { time: formatDurationShort(elapsedMs) }),
          );
        } else if (!this.opts.json) {
          this.output.write(this.output.i18n.t("runtime.cancelledMarker"));
        }
        if (this.opts.json) {
          this.output.emit("turn.aborted", {
            status: turn.status,
            finish_reason: turn.finishReason,
            steps: turn.steps,
            duration_ms: elapsedMs,
            steered: wasInterruptedForSteer,
          });
        }
      } else if (turn.text) {
        this.lastAssistantText = turn.text;
        const turnTokens = turn.usage?.total_tokens;
        const metaParts = [
          formatDurationShort(elapsedMs),
          `${turn.steps} ${turn.steps === 1 ? "step" : "steps"}`,
        ];
        if (turn.toolCalls > 0) {
          metaParts.push(
            `${turn.toolCalls} ${turn.toolCalls === 1 ? "tool" : "tools"}`,
          );
        }
        if (newEvidence > 0) metaParts.push(`+${newEvidence} evidence`);
        if (turnTokens) metaParts.push(`${turnTokens} tok`);
        metaParts.push(`ctx ${this.contextSnapshot().percent}%`);
        ui?.annotateLastAssistant(metaParts.join(" · "));

        if (!ui && !this.opts.json && !streamedAny) {
          this.output.write(turn.text);
        }
        if (this.opts.json) {
          this.output.emit("assistant", {
            status: turn.status,
            finish_reason: turn.finishReason,
            text: turn.text,
            steps: turn.steps,
            tool_calls: turn.toolCalls,
            usage: turn.usage,
            duration_ms: elapsedMs,
          });
        }
        await this.appendReport(label, turn.text);

        if (options?.autoSaveScriptPrefix) {
          const saved = await saveCodeBlockToDisk(
            { ...this.session, target: this.currentTarget },
            turn.text,
            {
              cwd: this.cwd,
              defaultPrefix: options.autoSaveScriptPrefix,
            },
          ).catch(() => null);
          if (saved) {
            this.lastSavedScriptPath = saved.path;
            const note = `saved generated script → ${saved.path} (${saved.bytes} bytes · /save to export elsewhere)`;
            if (ui) ui.addSystem(note);
            else if (this.opts.json) {
              this.output.emit("script.saved", {
                path: saved.path,
                bytes: saved.bytes,
              });
            } else {
              this.output.write(`  ${note}`);
            }
          }
        }
      }
      await this.persistHistory(this.agent.history, this.currentTarget);
    } catch (error) {
      const message = errorMessageOf(error);
      ui?.setBusy(null);
      if (
        ui?.currentNetworkStatus &&
        ui.currentNetworkStatus.state !== "restored"
      ) {
        ui.setNetworkStatus(null);
      }
      if (signal.aborted) {
        this.output.recordOutcome({ status: "cancelled", finishReason: null });
        this.output.systemNotice(this.output.i18n.t("runtime.preparationCancelled"));
        this.output.emit("turn.aborted", { label, steps: 0, tool_calls: 0 });
      } else {
        this.output.fail(this.output.i18n.t("runtime.modelError", { detail: message }));
        if (this.opts.json) this.output.writeError(this.output.i18n.t("runtime.modelError", { detail: message }));
      }
    } finally {
      this.activeAbort = null;
      this.interruptingForSteer = false;
      ui?.setBusy(null);
      await this.syncLocalStatus();
    }

    if (!this.exiting && this.pendingSteerCount() > 0) {
      const nextSteers = this.drainAllPendingSteers();
      if (nextSteers.length > 0) {
        for (const item of nextSteers) {
          ui?.addUser(`✻ [steer] ${item.text}`);
        }
        const combinedText = nextSteers.map((item) => item.text).join("\n");
        const combinedImages: ChatImageBlock[] = [];
        for (const item of nextSteers) {
          if (item.images) combinedImages.push(...item.images);
        }
        const matchedWorkflows = matchWorkflowsForInput(combinedText);
        const wfHint = autonomousWorkflowNote(combinedText);
        const autoPrefix = matchedWorkflows.find(
          (w) => w.autoSavePrefix,
        )?.autoSavePrefix;
        await this.runTurn(
          wfHint ? `${combinedText}\n\n${wfHint}` : combinedText,
          combinedText.slice(0, 80),
          {
            ...(autoPrefix ? { autoSaveScriptPrefix: autoPrefix } : {}),
            ...(combinedImages.length > 0 ? { images: combinedImages } : {}),
          },
        );
      }
    }
  }
}
