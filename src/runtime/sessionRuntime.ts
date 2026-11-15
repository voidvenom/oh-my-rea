import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserManager } from "../browser.js";
import type { ReaBroker } from "../broker.js";
import { writeJsonAtomic } from "../durable.js";
import { JournalTailer } from "../journal.js";
import { errorMessage, type ReaPort } from "../rea.js";
import type { SessionInfo } from "../session.js";
import type { SubagentRunner } from "../subagent.js";
import { asArray, asRecord, asString } from "../values.js";
import { TargetCoordinator } from "../concurrency.js";
import { ExecutionStore, UncertainInvocationError } from "../execution.js";
import { BudgetModelClient, UsageLedger } from "../usage.js";
import type { ModelPort } from "../model.js";
import { TaskStateStore } from "../taskState.js";
import { coverageTool, forgeManagementTool, recipeTool, taskStateTool, type LocalTool } from "../localTools.js";
import { ForgeRegistry } from "../forge.js";
import { RecipeEngine } from "../recipes.js";
import { ProgressTracker } from "../progress.js";
import { CoverageService } from "../coverage.js";
import { ContextArchive, contextArchiveTool } from "../contextArchive.js";
import { InvestigationState, investigationTool } from "../investigation.js";

export interface SessionBinding {
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly target: string | null;
  readonly targetEpoch: number;
}

export interface EvidenceOrigin {
  readonly sourceSessionId: string;
  readonly sourceDir: string;
  readonly target: string | null;
  readonly kind: "fork" | "resume" | "reconnect";
  readonly status: "unverified" | "imported";
  readonly reason: string;
}

/** One owner for every resource whose identity must change together at a session boundary. */
export class SessionRuntime {
  readonly id = randomUUID();
  readonly lifecycle = new AbortController();
  readonly targetAccess = new TargetCoordinator();
  readonly events: ExecutionStore;
  readonly progress: ProgressTracker;
  readonly usage: UsageLedger;
  readonly task: TaskStateStore;
  readonly archive: ContextArchive;
  readonly investigation: InvestigationState;
  private targetSelector: ((path: string, signal?: AbortSignal) => Promise<void>) | null = null;
  readonly forge: ForgeRegistry;
  readonly recipes: RecipeEngine;
  readonly coverage: CoverageService;
  readonly browser: BrowserManager;
  readonly workers: SubagentRunner;
  readonly journal: JournalTailer;
  readonly importedEvidenceIds = new Set<string>();
  rea: ReaPort | null = null;
  broker: ReaBroker | null = null;
  evidenceOrigin: EvidenceOrigin | null = null;
  private targetEpoch = 1;
  private selectedTarget: string | null;
  private exporting: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private selectionEstablished = false;
  private hasConnected = false;
  private readonly models = new WeakMap<ModelPort, Map<string, BudgetModelClient>>();

  constructor(readonly session: SessionInfo, env: NodeJS.ProcessEnv, createWorkers: (runtime: SessionRuntime) => SubagentRunner, target = session.target, cwd = process.cwd()) {
    this.selectedTarget = target;
    this.events = new ExecutionStore(session.id, session.dir);
    this.progress = new ProgressTracker(session.id, this.events);
    this.usage = new UsageLedger(session.dir, this.events);
    this.task = new TaskStateStore(session.dir, this.events);
    this.archive = new ContextArchive(session.dir, session.id);
    this.investigation = new InvestigationState({directory: session.dir, sessionId: session.id, cwd, signal: this.lifecycle.signal, rea: () => this.rea, target: () => this.target,
      selectTarget: (path, signal) => this.targetSelector ? this.targetSelector(path, signal) : this.targetAccess.run("write", async () => {this.setTarget(path);}, signal)});
    this.forge = new ForgeRegistry(session.dir, session.id, this.events, name => {
      if (this.rea?.find(name)) throw new Error(`Forge tool name collision with REA: ${name}`);
    });
    this.browser = new BrowserManager(session.dir, env, {
      invoke: (tool, args, readOnly, work, signal) => this.events.invoke({backend: "browser", tool, args, readOnly, binding: this.binding}, async () => {
        const result = await work();
        const payload = asRecord(asRecord(result)?.["payload"]);
        const code = asString(asRecord(payload?.["__error"])?.["code"]);
        if (!readOnly && (code === "TIMEOUT" || code === "CANCELLED")) throw new Error(`Browser operation ended without a definitive response (${code})`);
        return result;
      }, signal),
    });
    this.journal = new JournalTailer(session.journalPath);
    this.recipes = new RecipeEngine({ sessionId: session.id, directory: session.dir, trace: this.events, signal: this.lifecycle.signal, rea: () => this.rea, binding: () => this.binding,
      activeCdpEndpoint: () => { const local = this.browser.context.read().local; return local?.status === "owned" ? local.cdpEndpoint : null; },
      assertRecoveryReady: () => this.assertRecoveryReady(), withLease: (work, signal) => this.withTargetLease(this.binding, work, signal) });
    this.coverage = new CoverageService({ task: this.task, forge: this.forge, recipes: this.recipes, progress: this.progress, rea: () => this.rea, binding: () => this.binding, origin: () => this.evidenceOrigin, signal: this.lifecycle.signal,
      initialize: () => this.events.initialize(), withLease: (work, signal) => this.withTargetLease(this.binding, work, signal) });
    this.workers = createWorkers(this);
  }

  get binding(): SessionBinding {
    return {runtimeId: this.id, sessionId: this.session.id, target: this.selectedTarget, targetEpoch: this.targetEpoch};
  }

  model(client: ModelPort, scope: string): ModelPort {
    let scoped = this.models.get(client);
    if (!scoped) {scoped = new Map();this.models.set(client, scoped);}
    let wrapped = scoped.get(scope);
    if (!wrapped) {wrapped = new BudgetModelClient(client, this.usage, scope);scoped.set(scope, wrapped);}
    return wrapped;
  }

  setTargetSelector(select: (path: string, signal?: AbortSignal) => Promise<void>): void {this.targetSelector = select;}
  localTools(): readonly LocalTool[] { return [taskStateTool(this.task), contextArchiveTool(this.archive), investigationTool(this.investigation), forgeManagementTool(this.forge), recipeTool(this.recipes), coverageTool(this.coverage), ...this.forge.tools()]; }
  get target(): string | null { return this.selectedTarget; }
  setTarget(target: string | null): void {
    if (target !== this.selectedTarget) this.targetEpoch += 1;
    this.selectedTarget = target;
  }

  async withTargetLease<T>(expected: SessionBinding, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.targetAccess.run("read", async () => {
      const current = this.binding;
      if (expected.runtimeId !== current.runtimeId || expected.targetEpoch !== current.targetEpoch || expected.target !== current.target) {
        throw new Error("Worker target/session binding changed while waiting; spawn a new task for the current target");
      }
      return work();
    }, signal);
  }

  /** All native callers, including slash commands, participate in the same target boundary. */
  attachRea(raw: ReaPort): ReaPort {
    if (this.hasConnected) this.targetEpoch += 1;
    this.hasConnected = true; this.selectionEstablished = false;
    const mutations = new Set(["open_binary", "close_binary", "open_bundle_resources", "reset_investigation"]);
    const port: ReaPort = {
      sessionDir: raw.sessionDir, envSources: raw.envSources,
      get isClosed() {return raw.isClosed;},
      get processId() {return raw.processId;},
      get catalogRevision() {return raw.catalogRevision;},
      ...(raw.refreshTools ? { refreshTools: () => raw.refreshTools!() } : {}),
      tools: () => raw.tools(), find: (name) => raw.find(name), diagnostics: () => raw.diagnostics(),
      prompts: () => raw.prompts(), getPrompt: (name, args) => raw.getPrompt(name, args), close: () => raw.close(),
      call: (name, args, options) => {
        const catalogRevision = options?.catalogRevision ?? raw.catalogRevision;
        return this.targetAccess.run(mutations.has(name) ? "write" : "read", async () => {
        await this.investigation.initialize();
        const firstBinding = name === "open_binary" && !this.selectionEstablished && args["path"] === this.target;
        if (mutations.has(name) && !firstBinding) this.targetEpoch += 1;
        const result = await this.events.invoke({backend: "rea", tool: name, args, readOnly: raw.find(name)?.readOnly === true, binding: this.binding}, () => {this.investigation.beforeNative(name);return raw.call(name, args, { ...options, catalogRevision });}, options?.signal);
        if (!result.isError) {
          if (name === "open_binary" || name === "open_bundle_resources") {
            this.setTarget(asString(args["path"]) || null); this.selectionEstablished = true;
          } else if (name === "close_binary") {this.setTarget(null); this.selectionEstablished = false;}
        }
        this.investigation.observe(name, args, result);
        await this.investigation.flush();
        return result;
        }, options?.signal);
      },
    };
    this.rea = port;
    this.investigation.backendChanged();
    return port;
  }

  async assertRecoveryReady(): Promise<void> {
    const blocker = (await this.events.recoveryPending()).find((intent) => !intent.readOnly);
    if (blocker) throw new UncertainInvocationError(blocker.id);
  }

  async setOrigin(source: SessionInfo, kind: EvidenceOrigin["kind"]): Promise<void> {
    this.evidenceOrigin = {sourceSessionId: source.id, sourceDir: source.dir, target: source.target, kind, status: "unverified", reason: "Conversation references are historical until their Evidence bundle is imported into the active backend."};
    await this.persistOrigin();
  }
  private async persistOrigin(): Promise<void> {
    if (this.evidenceOrigin) await writeJsonAtomic(join(this.session.dir, "origin.json"), this.evidenceOrigin);
  }

  /** Export is serialized with itself and is only available when the server advertises the tool. */
  captureEvidence(): Promise<void> {
    if (this.exporting) return this.exporting;
    if (!this.rea?.find("export_evidence_bundle")) return Promise.resolve();
    const rea = this.rea;
    this.exporting = (async () => {
      const result = await rea.call("export_evidence_bundle", {path: join(this.session.dir, "evidence-bundle.json"), overwrite: true});
      if (result.isError) throw new Error(errorMessage(result.payload) ?? result.text);
    })().finally(() => { this.exporting = null; });
    return this.exporting;
  }

  async restoreEvidence(): Promise<void> {
    this.importedEvidenceIds.clear();
    const path = join(this.session.dir, "evidence-bundle.json");
    let bundle: unknown;
    try { bundle = JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && this.evidenceOrigin) {
        this.evidenceOrigin = {...this.evidenceOrigin, status: "unverified", reason: `Saved Evidence bundle could not be read: ${error instanceof Error ? error.message : String(error)}`};
      }
      await this.persistOrigin(); return;
    }
    if (!this.evidenceOrigin) await this.setOrigin(this.session, "reconnect");
    let reason = "Active backend does not advertise import_evidence_bundle; historical references remain unverified.";
    let imported = false;
    if (this.rea?.find("import_evidence_bundle")) {
      try {
        const result = await this.rea.call("import_evidence_bundle", {path});
        if (result.isError) throw new Error(errorMessage(result.payload) ?? result.text);
        imported = true;
        reason = "Backend authenticated and imported the saved bundle. These are historical observations, not a new observation of the current artifact.";
        for (const record of asArray(asRecord(bundle)?.["records"])) {
          const id = asString(asRecord(record)?.["evidence_id"]);
          if (/^ev_[0-9a-f]{64}$/.test(id)) this.importedEvidenceIds.add(id);
        }
      } catch (error) { reason = `Evidence import failed: ${error instanceof Error ? error.message : String(error)}`; }
    }
    this.evidenceOrigin = {...this.evidenceOrigin!, status: imported ? "imported" : "unverified", reason};
    await this.persistOrigin();
  }

  evidenceNote(): string | null {
    const origin = this.evidenceOrigin;
    return origin ? `[session origin: ${origin.sourceSessionId}; target=${origin.target ?? "none"}; Evidence=${origin.status}; ${origin.reason}]` : null;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.lifecycle.abort();
      await this.workers.cancelAll();
      const cleanup = await Promise.allSettled([this.browser.close(), this.rea?.close(), this.investigation.close()]);
      await this.events.flush();
      this.rea = null; this.broker = null;
      const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), "Session resource cleanup failed");
    })();
    return this.closing;
  }
}
