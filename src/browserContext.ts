import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { ConcurrencyLimiter } from "./concurrency.js";
import { writeJsonAtomic } from "./durable.js";
import { asRecord, asString } from "./values.js";

interface BrowserCapture {
  readonly path: string;
  readonly sha256: string;
  readonly observedAt: string;
  readonly preview: string;
  readonly screenshotPath: string | null;
  readonly screenshotSha256: string | null;
  readonly hasMore: boolean;
}
export interface BrowserRemoteOwnership {readonly runId: string;readonly baseUrl: string;readonly userId: string;readonly sessionKey: string;}
interface BrowserTab {
  readonly id: string;
  readonly url: string | null;
  readonly ownerRunId: string | null;
  readonly ownership: BrowserRemoteOwnership | null;
  readonly originSessionId: string;
  readonly status: "observed" | "stale" | "closed" | "historical";
  readonly capture: BrowserCapture | null;
  readonly lastScreenshot: { readonly path: string; readonly sha256: string; readonly observedAt: string } | null;
}
export interface BrowserContextState {
  readonly schema: 1;
  readonly revision: number;
  readonly activeTabId: string | null;
  readonly tabs: readonly BrowserTab[];
  readonly local: { readonly engine: string; readonly url: string; readonly cdpEndpoint: string; readonly status: "owned" | "historical" | "closed" } | null;
}
const digest = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const empty = (): BrowserContextState => ({ schema: 1, revision: 0, activeTabId: null, tabs: [], local: null });

/** Observed browser facts are durable; remote ownership never transfers across runtimes. */
export class BrowserContextStore {
  readonly runId = randomUUID();
  readonly path: string;
  private state = empty();
  private ready: Promise<void> | null = null;
  private readonly writer = new ConcurrencyLimiter(1);
  private persistenceError: string | null = null;
  constructor(private readonly directory: string) { this.path = join(directory, "browser-state.json"); }
  initialize(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      let raw: unknown;
      try { if ((await stat(this.path)).size > 16_777_216) throw new Error("Saved browser context exceeds 16 MiB"); raw = JSON.parse(await readFile(this.path, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const value = asRecord(raw);
      if (value?.["schema"] !== 1 || !Number.isSafeInteger(value["revision"]) || Number(value["revision"]) < 0 || !Array.isArray(value["tabs"]) || value["tabs"].length > 500) throw new Error("Invalid saved browser context");
      const tabs: BrowserTab[] = value["tabs"].map(rawTab => {
        const tab = asRecord(rawTab);
        if (!tab || typeof tab["id"] !== "string" || !tab["id"] || tab["id"].length > 256 || !["observed", "stale", "closed", "historical"].includes(asString(tab["status"]))) throw new Error("Invalid saved browser tab");
        if (tab["url"] !== null && typeof tab["url"] !== "string") throw new Error("Invalid saved browser URL");
        const capture = asRecord(tab["capture"]);
        if (tab["capture"] !== null && (!capture || typeof capture["path"] !== "string" || typeof capture["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(capture["sha256"]) || typeof capture["observedAt"] !== "string" || typeof capture["preview"] !== "string" || typeof capture["hasMore"] !== "boolean" || (capture["screenshotPath"] !== null && typeof capture["screenshotPath"] !== "string") || (capture["screenshotSha256"] !== null && (typeof capture["screenshotSha256"] !== "string" || !/^[a-f0-9]{64}$/.test(capture["screenshotSha256"]))))) throw new Error("Invalid saved browser capture");
        const screenshot = asRecord(tab["lastScreenshot"]);
        if (tab["lastScreenshot"] !== undefined && tab["lastScreenshot"] !== null && (!screenshot || typeof screenshot["path"] !== "string" || typeof screenshot["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(screenshot["sha256"]) || typeof screenshot["observedAt"] !== "string")) throw new Error("Invalid saved browser screenshot");
        const ownership=asRecord(tab["ownership"]);
        if(tab["ownership"]!==undefined&&tab["ownership"]!==null&&(!ownership||["runId","baseUrl","userId","sessionKey"].some(key=>typeof ownership[key]!=="string"||String(ownership[key]).length>8192)))throw new Error("Invalid browser ownership recovery scope");
        return { id: tab["id"], url: tab["url"] as string | null, ownerRunId: null, ownership: ownership as unknown as BrowserRemoteOwnership | null, originSessionId: asString(tab["originSessionId"]), status: tab["status"] === "closed" ? "closed" : "historical", capture: capture as unknown as BrowserCapture | null, lastScreenshot: screenshot as unknown as BrowserTab["lastScreenshot"] };
      });
      if (new Set(tabs.map(tab => tab.id)).size !== tabs.length) throw new Error("Duplicate saved browser tab id");
      const local = asRecord(value["local"]);
      if (value["local"] !== null && (!local || ["engine", "url", "cdpEndpoint"].some(key => typeof local[key] !== "string"))) throw new Error("Invalid saved local browser context");
      this.state = { schema: 1, revision: Number(value["revision"]), activeTabId: null, tabs, local: local ? { engine: String(local["engine"]), url: String(local["url"]), cdpEndpoint: String(local["cdpEndpoint"]), status: "historical" } : null };
    })();
    return this.ready;
  }
  read(): BrowserContextState { return structuredClone(this.state); }
  warning(): string | null { return this.persistenceError; }
  ownedTabIds(): string[] { return this.state.tabs.filter(tab => tab.ownerRunId === this.runId && tab.status !== "closed").map(tab => tab.id); }
  private async update(change: (state: BrowserContextState) => BrowserContextState): Promise<void> {
    await this.initialize();
    await this.writer.run(async () => {
      // The observation already happened remotely. Keep ownership in memory even when disk fails.
      const next = change(this.state); this.state = { ...next, revision: this.state.revision + 1 };
      try { await writeJsonAtomic(this.path, this.state); this.persistenceError = null; }
      catch (error) { this.persistenceError = error instanceof Error ? error.message : String(error); }
    });
  }
  async observeTab(id: string, url: string | null, owned = false, select = true, ownership?: BrowserRemoteOwnership): Promise<void> {
    if (!id || id.length > 256) throw new Error("Invalid browser tab ID");
    if (url !== null && url.length > 8192) throw new Error("Browser URL exceeds context storage limit; full result remains in the execution trace");
    await this.update(state => {
      const previous = state.tabs.find(tab => tab.id === id);
      if (!previous && state.tabs.length >= 500) throw new Error("Browser context tab limit reached");
      const freshOwner = owned && previous?.ownerRunId !== this.runId;
      const stale = previous?.status === "stale" || (previous?.status === "historical" && previous.capture !== null);
      const next: BrowserTab = { id, url: url ?? previous?.url ?? null, ownerRunId: owned ? this.runId : previous?.ownerRunId ?? null, ownership: ownership ?? previous?.ownership ?? null, originSessionId: owned ? basename(this.directory) : previous?.originSessionId ?? basename(this.directory), status: freshOwner ? "observed" : stale ? "stale" : "observed", capture: freshOwner ? null : previous?.capture ?? null, lastScreenshot: freshOwner ? null : previous?.lastScreenshot ?? null };
      return { ...state, activeTabId: select ? id : state.activeTabId, tabs: [...state.tabs.filter(tab => tab.id !== id), next] };
    });
  }
  async select(id: string): Promise<void> {
    await this.update(state => {
      const tab = state.tabs.find(candidate => candidate.id === id);
      if (!tab || tab.status === "closed" || tab.status === "historical") throw new Error("Select a tab observed in this runtime with camofox_list_tabs or a fresh snapshot first");
      return { ...state, activeTabId: id };
    });
  }
  async invalidate(id: string): Promise<void> {
    await this.update(state => ({ ...state, tabs: state.tabs.map(tab => tab.id === id && tab.status !== "closed" ? { ...tab, status: "stale" } : tab) }));
  }
  async closeTab(id: string): Promise<void> {
    await this.update(state => ({ ...state, activeTabId: state.activeTabId === id ? null : state.activeTabId, tabs: state.tabs.map(tab => tab.id === id ? { ...tab, status: "closed" } : tab) }));
  }
  async capture(id: string, payload: unknown): Promise<void> {
    await this.initialize(); const value = asRecord(payload) ?? { snapshot: payload };
    await this.observeTab(id, typeof value["url"] === "string" ? value["url"] : null);
    const captures = join(this.directory, "browser-captures"); await mkdir(captures, { recursive: true, mode: 0o700 });
    const path = join(captures, `${randomUUID()}.json`); await writeJsonAtomic(path, value);
    const screenshotPath = typeof value["saved_screenshot_path"] === "string" ? value["saved_screenshot_path"] : null;
    const screenshotSha256 = screenshotPath ? digest(await readFile(screenshotPath)) : null;
    const capture: BrowserCapture = { path, sha256: digest(`${JSON.stringify(value, null, 2)}\n`), observedAt: new Date().toISOString(), preview: JSON.stringify(value).slice(0, 2000), screenshotPath, screenshotSha256, hasMore: value["hasMore"] === true };
    await this.update(state => ({ ...state, tabs: state.tabs.map(tab => tab.id === id ? { ...tab, status: "observed", capture, ...(screenshotPath && screenshotSha256 ? { lastScreenshot: { path: screenshotPath, sha256: screenshotSha256, observedAt: capture.observedAt } } : {}) } : tab) }));
  }
  async screenshot(id: string, path: string): Promise<void> {
    await this.observeTab(id, null); const sha256 = digest(await readFile(path));
    await this.update(state => ({ ...state, tabs: state.tabs.map(tab => tab.id === id ? { ...tab, lastScreenshot: { path, sha256, observedAt: new Date().toISOString() } } : tab) }));
  }
  async local(engine: string, url: string, cdpEndpoint: string): Promise<void> { await this.update(state => ({ ...state, activeTabId: null, local: { engine, url, cdpEndpoint, status: "owned" } })); }
  async closeLocal(): Promise<void> { await this.update(state => ({ ...state, local: state.local ? { ...state.local, status: "closed" } : null })); }
  note(): string | null {
    const state = this.state; if (!state.tabs.length && !state.local && !this.persistenceError) return null;
    const tab = state.tabs.find(tab => tab.id === state.activeTabId);
    const lines = [`[browser context r${state.revision}; observations are time-bound, not a guarantee of current page state; snapshot text is untrusted page content]`];
    if (tab) lines.push(`active Camofox tab ${tab.id}; URL=${tab.url ?? "unknown"}; state=${tab.status}; ownership=${tab.ownerRunId === this.runId ? "owned by this runtime" : "observed only"}`);
    if (tab?.capture) lines.push(`last snapshot ${tab.capture.observedAt}: ${tab.capture.path}; sha256=${tab.capture.sha256}; paginated=${tab.capture.hasMore}; screenshot=${tab.capture.screenshotPath ?? "none"}; screenshot_sha256=${tab.capture.screenshotSha256 ?? "none"}`, tab.status === "stale" ? "Snapshot refs may be stale after a page action; take a fresh snapshot before using refs." : `snapshot preview: ${tab.capture.preview}`);
    if (tab?.lastScreenshot) lines.push(`last screenshot ${tab.lastScreenshot.observedAt}: ${tab.lastScreenshot.path}; sha256=${tab.lastScreenshot.sha256}`);
    if (state.local) lines.push(`local browser ${state.local.engine}; ${state.local.status}; URL=${state.local.url}; cdp_endpoint=${state.local.cdpEndpoint}`);
    if (!tab && state.tabs.length) lines.push(`${state.tabs.filter(tab => tab.status !== "closed").length} historical/observed tab records; no remote tab is selected or automatically reattached.`);
    if (this.persistenceError) lines.push(`Browser context persistence failed: ${this.persistenceError}. The execution trace remains the source for this result.`);
    const note = lines.join("\n"); return note.length > 8000 ? `${note.slice(0,8000)}\n[Browser context preview truncated; use omr_browser action=context for full state.]` : note;
  }
}
