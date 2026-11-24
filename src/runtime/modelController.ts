import {
  normalizeCompactionModelSpec,
  persistCompactionSettings,
  type CompactionSettings,
} from "../compaction.js";
import {
  FailoverModelClient,
  ModelClient,
  type FailoverCandidate,
  type ModelPort,
} from "../model.js";
import {
  infoFromProvider,
  readStoredModelConfig,
  resolveModelConfig,
  saveDefaultModelConfig,
  saveReasoningEffortDefault,
  saveModelRuntimeSettings,
  splitProviderModelSpec,
  withModelId,
  withReasoningEffort,
  type ModelConfig,
  type ModelConfigInfo,
  type ReasoningEffort,
} from "../modelConfig.js";
import { sameEndpoint } from "../customEndpoint.js";
import type { CatalogCache, RouterCandidate } from "../localRouters.js";
import {
  discoverProvidersSync,
  fetchProviderModels,
  inferProtocolFromUrl,
  refreshAllProviders,
  type ResolvedProvider,
} from "../providers.js";
import { resolveLimits } from "../modelLimits.js";
import type { OutputSink } from "./output.js";

export interface ModelControllerCallbacks {
  readonly getCompactionSettings: () => CompactionSettings;
  readonly setCompactionSettings: (next: CompactionSettings) => void;
  readonly onModelUpdated: () => Promise<void>;
}

/**
 * Manages LLM provider discovery, model/effort switching, dedicated compaction AI selection,
 * and interactive TUI picker workflows.
 */
export class ModelController {
  storedModelConfig: Record<string, unknown> | null;
  /** Config and built-in providers, as discovered and live-refreshed. */
  private baseProviders: readonly ResolvedProvider[];
  /** Detected routers and session providers; merged into `providers` on every change. */
  private readonly overlays = new Map<string, ResolvedProvider>();
  private merged: readonly ResolvedProvider[];
  private discoveryJob: { readonly generation: number; readonly abort: AbortController; readonly done: Promise<void> } | null = null;
  private discoveryGeneration = 0;
  private lastScan: { readonly at: number; readonly found: number; readonly signature: string } | null = null;
  private readonly catalogCache: CatalogCache = new Map();
  modelInfo: ModelConfigInfo | null = null;
  modelError: string | null = null;
  modelId: string;
  private providersRefreshing = false;
  private providersRefreshedOnce = false;
  private readonly createClient: (config: ModelConfig) => ModelPort;
  private activeClientCache: {
    key: string;
    callbacks: readonly unknown[];
    client: ModelPort;
  } | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly noModel: boolean,
    private readonly initialModelFlag: string | null,
    private readonly output: OutputSink,
    private readonly callbacks: ModelControllerCallbacks,
    createClient?: (config: ModelConfig) => ModelPort,
  ) {
    this.createClient =
      createClient ??
      ((config: ModelConfig) =>
        new ModelClient({
          ...config,
          onNetworkStatus:
            config.onNetworkStatus ??
            ((notice) => {
              this.output.ui?.setNetworkStatus(notice);
            }),
        }));
    this.storedModelConfig = readStoredModelConfig(env);
    this.baseProviders = discoverProvidersSync(env, this.storedModelConfig);
    this.merged = this.baseProviders;

    if (!noModel) {
      try {
        this.modelInfo = resolveModelConfig(env, initialModelFlag);
      } catch (error) {
        this.modelError =
          error instanceof Error ? error.message : String(error);
      }
    }
    this.modelId = noModel
      ? "no-model"
      : (this.modelInfo?.config.model ?? "unconfigured");
  }

  get providers(): readonly ResolvedProvider[] {
    return this.merged;
  }

  private setBaseProviders(next: readonly ResolvedProvider[]): void {
    this.baseProviders = next;
    this.recomputeProviders();
  }

  /** Apply `update` to the base entry and the overlay entry with this id (either may be absent). */
  private updateProvider(id: string, update: (provider: ResolvedProvider) => ResolvedProvider): void {
    const overlay = this.overlays.get(id);
    if (overlay) this.overlays.set(id, update(overlay));
    this.baseProviders = this.baseProviders.map((provider) => (provider.id === id ? update(provider) : provider));
    this.recomputeProviders();
  }

  /**
   * Overlays that describe the same endpoint as a base provider enrich it (the base keeps its id, name and key);
   * all other overlays are appended. Base providers are never replaced by an overlay's credentials.
   */
  private recomputeProviders(): void {
    const out = [...this.baseProviders];
    for (const overlay of this.overlays.values()) {
      const index = out.findIndex((provider) => provider.id === overlay.id || sameEndpoint(provider.baseUrl, overlay.baseUrl));
      const existing = index >= 0 ? out[index] : undefined;
      if (existing) {
        out[index] = {
          ...existing,
          ...(existing.product ?? overlay.product ? { product: (existing.product ?? overlay.product)! } : {}),
          ...(overlay.catalogStatus ? { catalogStatus: overlay.catalogStatus } : {}),
          ...(overlay.httpStatus !== undefined ? { httpStatus: overlay.httpStatus } : {}),
          models: overlay.models.length > 0 ? overlay.models : existing.models,
          liveLoaded: existing.liveLoaded || overlay.liveLoaded,
          error: overlay.error ?? existing.error,
        };
      } else {
        out.push(overlay);
      }
    }
    this.merged = out;
  }

  resolveSpecInfo(rawSpec: string, roleLabel = "model"): ModelConfigInfo {
    const parsed = splitProviderModelSpec(rawSpec, this.providers);
    if (parsed.providerId) {
      const targetProv = this.providers.find(
        (p) => p.id === parsed.providerId!.toLowerCase(),
      );
      if (!targetProv)
        throw new Error(`Unknown ${roleLabel} provider "${parsed.providerId}".`);
      if (!targetProv.connected && !targetProv.local) {
        throw new Error(
          `${roleLabel[0]!.toUpperCase()}${roleLabel.slice(1)} provider "${targetProv.name}" is not connected. Export ${targetProv.envHint} first.`,
        );
      }
      if (!targetProv.baseUrl) {
        throw new Error(
          `${roleLabel[0]!.toUpperCase()}${roleLabel.slice(1)} provider "${targetProv.name}" requires an endpoint URL (${targetProv.envHint}).`,
        );
      }
      return infoFromProvider(
        targetProv,
        parsed.modelId,
        this.env,
        this.storedModelConfig,
      );
    }
    const matchedConnected = this.providers.find(
      (p) =>
        p.connected &&
        p.baseUrl &&
        p.models.some(
          (m) => m.id.toLowerCase() === parsed.modelId.toLowerCase(),
        ),
    );
    if (matchedConnected) {
      return infoFromProvider(
        matchedConnected,
        parsed.modelId,
        this.env,
        this.storedModelConfig,
      );
    }
    if (this.modelInfo) {
      return withModelId(this.modelInfo, parsed.modelId);
    }
    return resolveModelConfig(this.env, parsed.modelId);
  }

  private readonly warnedUnknownWindow = new Set<string>();

  /**
   * Learn each configured model's real context window before the first request: the endpoint's
   * own model listing first, then the models.dev database (exact identity), both cached on disk.
   * Models no source knows stay unknown (no 32k guess) and the operator is told how to set one.
   * A window the operator pinned (`OMR_CONTEXT_WINDOW` / `context_window`) is never overridden.
   */
  private capabilityHydration: Promise<void> = Promise.resolve();

  /**
   * Starts `hydrateActiveCapabilities` without waiting for it. The lookup can hit the network (provider
   * `/models`, models.dev; up to 6 s each) whenever the 24 h limits cache is stale, so the interactive UI must
   * not wait for it before first paint. Anything that needs the context window (agent construction) awaits
   * {@link whenCapabilitiesReady}; failures are surfaced the same way as before (`warnedUnknownWindow`).
   */
  beginCapabilityHydration(signal?: AbortSignal): void {
    this.capabilityHydration = this.hydrateActiveCapabilities(signal).catch(() => {});
  }

  whenCapabilitiesReady(): Promise<void> {
    return this.capabilityHydration;
  }

  async hydrateActiveCapabilities(signal?: AbortSignal): Promise<void> {
    if (this.noModel || !this.modelInfo) return;
    const primary = this.modelInfo.config;
    const configs: ModelConfig[] = [primary];
    for (const raw of primary.fallbackModels ?? []) {
      try { configs.push(this.resolveSpecInfo(raw, "fallback").config); } catch { /* unconnected fallback */ }
    }
    const pinned = this.callbacks.getCompactionSettings().windowSource === "operator";
    for (const config of configs) {
      if (pinned && config === primary) continue;
      await this.hydrateModel(config, signal);
    }
  }

  private async hydrateModel(config: ModelConfig, signal?: AbortSignal): Promise<void> {
    const providerId = config.providerId ?? "custom";
    const provider = this.providers.find((candidate) => candidate.id === providerId);
    const state: { refreshed: ResolvedProvider | null } = { refreshed: null };
    const live = async () => {
      if (!provider?.baseUrl || (!provider.connected && !provider.local)) return undefined;
      // Routers and session endpoints get their catalog (with limits) from the bounded fetch, never the legacy probe.
      if (provider.product || provider.provenance === "detected" || provider.provenance === "session") {
        return provider.models.find((candidate) => candidate.id === config.model)?.capabilities;
      }
      const timeout = AbortSignal.timeout(6_000);
      state.refreshed = await fetchProviderModels(provider, signal ? AbortSignal.any([signal, timeout]) : timeout);
      return state.refreshed.models.find((candidate) => candidate.id === config.model)?.capabilities;
    };
    const resolved = await resolveLimits(providerId, config.baseUrl, config.model, { env: this.env, live, ...(signal ? { signal } : {}) });
    const metadata = resolved?.metadata;
    this.updateProvider(providerId, (candidate) => {
      const base = state.refreshed ?? candidate;
      if (!metadata) return base;
      const known = base.models.some((model) => model.id === config.model);
      const models = known
        ? base.models.map((model) => (model.id === config.model ? { ...model, capabilities: { ...model.capabilities, ...metadata } } : model))
        : [...base.models, { id: config.model, label: config.model, source: "configured" as const, capabilities: metadata }];
      return { ...base, models };
    });
    if (!metadata?.contextWindow) {
      const key = `${providerId}:${config.model}`;
      if (!this.warnedUnknownWindow.has(key)) {
        this.warnedUnknownWindow.add(key);
        this.output.writeError(
          `context window of ${config.model} is unknown (the endpoint does not report it and models.dev has no exact entry). ` +
            `Set OMR_CONTEXT_WINDOW or "context_window" in omr-model.json; until then omr will not compact proactively and will learn the limit from provider errors.`,
        );
      }
    }
  }

  buildActiveClient(): ModelPort | null {
    if (this.noModel || !this.modelInfo) {
      this.activeClientCache = null;
      return null;
    }
    const fallbackSpecs = this.modelInfo.config.fallbackModels ?? [];
    const primarySpec = `${this.modelInfo.config.providerId ? `${this.modelInfo.config.providerId}:` : ""}${this.modelInfo.config.model}`;
    const configured: Array<{ spec: string; config: ModelConfig }> = [
      { spec: primarySpec, config: this.modelInfo.config },
    ];
    for (const rawSpec of fallbackSpecs) {
      try {
        const fbInfo = this.resolveSpecInfo(rawSpec, "fallback");
        const fbSpec = `${fbInfo.config.providerId ? `${fbInfo.config.providerId}:` : ""}${fbInfo.config.model}`;
        if (configured.some((c) => c.spec === fbSpec)) continue;
        configured.push({
          spec: fbSpec,
          config: fbInfo.config,
        });
      } catch {
        // Unconnected fallback candidates are skipped cleanly.
      }
    }
    for (const entry of configured) {
      const metadata = this.providers.find((provider) => provider.id === entry.config.providerId)?.models.find((model) => model.id === entry.config.model)?.capabilities;
      if (metadata) entry.config = {...entry.config, modelMetadata: metadata};
      const context = this.callbacks.getCompactionSettings();
      if (entry.spec === primarySpec && context.windowSource === "operator") entry.config = {...entry.config, capabilities: {...entry.config.capabilities, contextWindow: context.contextWindow}};
    }
    // Capture values, not config identity: callers may replace an equivalent config or
    // mutate nested request settings. Function hooks need separate identity checks.
    const key = JSON.stringify(configured.map(({spec,config})=>{const {budgetTokens:_budget,...request}=config;return {spec,config:request};}));
    const callbacks = configured.flatMap(({ config }) => [
      config.networkProbe,
      config.onNetworkStatus,
    ]);
    const cached = this.activeClientCache;
    if (
      cached?.key === key &&
      callbacks.length === cached.callbacks.length &&
      callbacks.every((callback, index) => callback === cached.callbacks[index])
    ) return cached.client;

    const candidates: FailoverCandidate[] = configured.map(({ spec, config }) => ({
      spec,
      client: this.createClient(config),
    }));
    const client = candidates.length === 1
      ? candidates[0]!.client
      : new FailoverModelClient(candidates, (notice) => {
      this.modelId = notice.to;
      const msg = this.output.i18n.t("commandResult.modelFailover", notice)
        || `model failover: ${notice.from} → ${notice.to} (${notice.reason})`;
      if (this.output.ui) {
        this.output.ui.addSystem(`**⚡ ${msg}**`);
        this.output.ui.setStatus({ model: notice.to });
      } else {
        this.output.writeError(msg);
      }
      this.output.emit("model.failover", { ...notice });
      });
    this.activeClientCache = { key, callbacks, client };
    return client;
  }

  async applyFallbackModels(
    specs: readonly string[],
    saveDefault: boolean,
  ): Promise<{ specs: readonly string[]; savedPath: string | null }> {
    const cleaned = specs.map((s) => s.trim()).filter(Boolean);
    if (this.modelInfo) {
      this.modelInfo = {
        ...this.modelInfo,
        config: {
          ...this.modelInfo.config,
          fallbackModels: cleaned,
        },
      };
    }
    let savedPath: string | null = null;
    if (saveDefault) {
      const res = saveModelRuntimeSettings(
        { fallbackModels: cleaned },
        this.env,
      );
      savedPath = res.path;
      this.storedModelConfig = readStoredModelConfig(this.env);
    }
    await this.callbacks.onModelUpdated();
    return { specs: cleaned, savedPath };
  }

  resolveCompactionModelClient(specOverride?: string | null): ModelPort | null {
    if (this.noModel) return null;
    const settings = this.callbacks.getCompactionSettings();
    const rawSpec = normalizeCompactionModelSpec(
      specOverride !== undefined ? specOverride : settings.compactionModel,
    );
    if (!rawSpec) return null;
    const info = this.resolveSpecInfo(rawSpec, "compaction");
    return this.createClient(withReasoningEffort(info, "off").config);
  }

  private syncDiscoveredProviders(): void {
    const prevById = new Map(this.baseProviders.map((p) => [p.id, p]));
    const fresh = discoverProvidersSync(this.env, this.storedModelConfig);
    this.setBaseProviders(fresh.map((p) => {
      const prev = prevById.get(p.id);
      if (
        prev &&
        prev.liveLoaded &&
        prev.baseUrl === p.baseUrl &&
        prev.apiKey === p.apiKey &&
        prev.models.length >= p.models.length
      ) {
        return {
          ...p,
          models: prev.models,
          liveLoaded: true,
          error: prev.error,
        };
      }
      return p;
    }));
  }

  async triggerProvidersRefresh(
    force = false,
  ): Promise<readonly ResolvedProvider[]> {
    // A forced refresh also re-scans for routers (even when a provider refresh is already running).
    const discovery = force ? this.startRouterDiscovery(true) : Promise.resolve();
    if (this.providersRefreshing) {
      await discovery;
      return this.providers;
    }
    const anyConnectedPending = this.baseProviders.some(
      (p) => p.connected && !p.local && !p.liveLoaded && !p.product,
    );
    if (!force && this.providersRefreshedOnce && !anyConnectedPending) {
      return this.providers;
    }
    this.providersRefreshing = true;
    this.output.ui?.updateModelPicker({ loading: true });
    try {
      this.storedModelConfig = readStoredModelConfig(this.env);
      this.syncDiscoveredProviders();
      const toRefresh = force
        ? discoverProvidersSync(this.env, this.storedModelConfig)
        : this.baseProviders;
      // Routers (env-configured or saved) are refreshed by the bounded catalog fetch in the discovery job.
      const refreshed = new Map(
        (await refreshAllProviders(toRefresh.filter((p) => !p.product))).map((p) => [p.id, p]),
      );
      this.setBaseProviders(toRefresh.map((p) => refreshed.get(p.id) ?? p));
      await discovery;
      const allConnectedLoaded = this.providers
        .filter((p) => p.connected && !p.local && !p.product)
        .every((p) => p.liveLoaded);
      this.providersRefreshedOnce = allConnectedLoaded;
      const errProv = this.providers.find(
        (p) => p.connected && !p.local && !p.product && p.error,
      );
      this.output.ui?.updateModelPicker({
        providers: this.providers,
        loading: false,
        notice: errProv ? `${errProv.name}: ${errProv.error}` : null,
      });
      return this.providers;
    } finally {
      this.providersRefreshing = false;
      this.output.ui?.updateModelPicker({ loading: false });
    }
  }

  // ── Local router discovery ────────────────────────────────────────────────

  private discoveryCandidates(routerCandidates: (env: NodeJS.ProcessEnv) => readonly RouterCandidate[]): readonly RouterCandidate[] {
    const candidates = [...routerCandidates(this.env)];
    // Saved router providers are refreshed here (bounded fetch, own key) instead of the legacy probe.
    for (const provider of this.baseProviders) {
      if (!provider.product || provider.provenance !== "config-named") continue;
      if (candidates.some((candidate) => candidate.explicit === provider.product && sameEndpoint(candidate.apiBase, provider.baseUrl))) continue;
      let origin: string;
      try {
        origin = new URL(provider.baseUrl).origin;
      } catch {
        continue;
      }
      candidates.unshift({ origin, apiBase: provider.baseUrl, explicit: provider.product, apiKey: provider.apiKey });
    }
    return candidates;
  }

  /** The overlay id for a router: the matching base provider's id, an existing overlay's id, else the product id. */
  private routerOverlayId(product: string, apiBase: string): string {
    const base = this.baseProviders.find((provider) => sameEndpoint(provider.baseUrl, apiBase));
    if (base) return base.id;
    for (const [id, overlay] of this.overlays) {
      if (overlay.provenance === "detected" && overlay.product === product && sameEndpoint(overlay.baseUrl, apiBase)) return id;
    }
    for (let n = 1; ; n += 1) {
      const id = n === 1 ? product : `${product}-${n}`;
      if (!this.baseProviders.some((provider) => provider.id === id) && !this.overlays.has(id)) return id;
    }
  }

  /**
   * Looks for local routers without blocking the picker. Results arrive incrementally through
   * `updateModelPicker`; a stale job (cancelled or superseded) never touches state.
   */
  startRouterDiscovery(force = false): Promise<void> {
    if (this.noModel) return Promise.resolve();
    if (this.discoveryJob && !force) return this.discoveryJob.done;
    const ui = this.output.ui;
    const run = async (generation: number, signal: AbortSignal): Promise<void> => {
      const { discoverLocalRouters, routerCandidates, routerProvider, DISCOVERY_LIMITS } = await import("../localRouters.js");
      const candidates = this.discoveryCandidates(routerCandidates);
      if (candidates.length === 0) return;
      const signature = candidates.map((candidate) => `${candidate.explicit ?? ""}@${candidate.apiBase}`).join(",");
      const last = this.lastScan;
      if (
        !force &&
        last?.signature === signature &&
        Date.now() - last.at < (last.found > 0 ? DISCOVERY_LIMITS.scanPositiveTtlMs : DISCOVERY_LIMITS.scanNegativeTtlMs)
      ) {
        ui?.updateModelPicker({ providers: this.providers });
        return;
      }
      ui?.updateModelPicker({ scanning: true });
      const touched = new Set<string>();
      const current = (): boolean => generation === this.discoveryGeneration && !signal.aborted;
      const found = await discoverLocalRouters({
        env: this.env,
        signal,
        candidates,
        cache: this.catalogCache,
        force,
        onRouter: (router) => {
          if (!current()) return;
          const id = this.routerOverlayId(router.product, router.apiBase);
          // A product that moved to another origin replaces its earlier overlay.
          for (const [otherId, other] of this.overlays) {
            if (otherId !== id && other.provenance === "detected" && other.product === router.product) {
              this.overlays.delete(otherId);
              touched.delete(otherId);
            }
          }
          this.overlays.set(id, routerProvider(router, id, this.env));
          touched.add(id);
          this.recomputeProviders();
          ui?.updateModelPicker({ providers: this.providers });
        },
      });
      if (!current()) return;
      const activeId = this.modelInfo?.config.providerId ?? null;
      for (const [id, overlay] of [...this.overlays]) {
        if (overlay.provenance !== "detected" || touched.has(id)) continue;
        if (id === activeId) {
          this.overlays.set(id, { ...overlay, catalogStatus: "offline", connected: true });
        } else {
          this.overlays.delete(id);
        }
      }
      this.recomputeProviders();
      this.lastScan = { at: Date.now(), found: found.length, signature };
      ui?.updateModelPicker({ providers: this.providers });
    };
    const generation = (this.discoveryGeneration += 1);
    this.discoveryJob?.abort.abort();
    const abort = new AbortController();
    const done: Promise<void> = run(generation, abort.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.discoveryJob?.generation !== generation) return;
        this.discoveryJob = null;
        if (!abort.signal.aborted) ui?.updateModelPicker({ scanning: false, providers: this.providers });
      });
    this.discoveryJob = { generation, abort, done };
    return done;
  }

  /** Stops an in-flight scan (the picker was closed). Overlays already applied stay. */
  cancelRouterDiscovery(): void {
    if (!this.discoveryJob) return;
    this.discoveryGeneration += 1;
    this.discoveryJob.abort.abort();
    this.discoveryJob = null;
  }

  async whenRouterDiscoveryIdle(): Promise<void> {
    while (this.discoveryJob) await this.discoveryJob.done;
  }

  openInteractiveModelPicker(focusProviderId?: string | null): void {
    const ui = this.output.ui;
    if (!ui) return;
    if (this.noModel) {
      ui.showOutput(
        "model",
        this.output.i18n.t("commandResult.modelDisabled"),
      );
      return;
    }
    this.storedModelConfig = readStoredModelConfig(this.env);
    this.syncDiscoveredProviders();
    const needsRefresh =
      !this.providersRefreshedOnce ||
      this.providers.some((p) => p.connected && !p.local && !p.liveLoaded && !p.product);
    ui.openModelPicker(
      this.providers,
      this.modelInfo?.config.providerId ?? null,
      this.modelInfo?.config.model ?? "",
      focusProviderId ?? null,
      needsRefresh,
      this.modelInfo?.config.reasoningEffort ?? "auto",
    );
    if (needsRefresh) {
      void this.triggerProvidersRefresh(false);
    }
    void this.startRouterDiscovery(false);
  }

  openInteractiveEffortPicker(): void {
    const ui = this.output.ui;
    if (!ui) return;
    if (this.noModel) {
      ui.showOutput(
        "effort",
        this.output.i18n.t("commandResult.effortDisabled"),
      );
      return;
    }
    this.storedModelConfig = readStoredModelConfig(this.env);
    this.syncDiscoveredProviders();
    ui.openEffortPicker(
      this.providers,
      this.modelInfo?.config.providerId ?? null,
      this.modelInfo?.config.model ?? "",
      this.modelInfo?.config.reasoningEffort ?? "auto",
    );
  }

  openInteractiveCompactionModelPicker(): void {
    const ui = this.output.ui;
    if (!ui) return;
    if (this.noModel) {
      ui.showOutput(
        "compaction",
        this.output.i18n.t("commandResult.compactionDisabled"),
      );
      return;
    }
    this.storedModelConfig = readStoredModelConfig(this.env);
    if (!this.providersRefreshedOnce) {
      this.setBaseProviders(discoverProvidersSync(this.env, this.storedModelConfig));
    }
    const settings = this.callbacks.getCompactionSettings();
    ui.openCompactionModelPicker(
      this.providers,
      this.modelInfo?.config.providerId ?? null,
      this.modelInfo?.config.model ?? "",
      settings.compactionModel ?? null,
      !this.providersRefreshedOnce,
    );
    if (!this.providersRefreshedOnce) {
      void this.triggerProvidersRefresh(false);
    }
    void this.startRouterDiscovery(false);
  }

  applyCompactionModelSelection(
    spec: string | null,
    saveDefault: boolean,
  ): { spec: string | null; savedPath: string | null } {
    if (this.noModel) {
      throw new Error(
        "Compaction model selection is disabled when launched with --no-model.",
      );
    }
    const normalizedSpec = normalizeCompactionModelSpec(spec);
    if (normalizedSpec) {
      this.resolveCompactionModelClient(normalizedSpec);
    }
    const next: CompactionSettings = {
      ...this.callbacks.getCompactionSettings(),
      compactionModel: normalizedSpec,
    };
    this.callbacks.setCompactionSettings(next);
    let savedPath: string | null = null;
    if (saveDefault) {
      savedPath = persistCompactionSettings(next, this.env).path;
      this.storedModelConfig = readStoredModelConfig(this.env);
    }
    return { spec: normalizedSpec, savedPath };
  }

  async applyModelSelection(
    explicitProviderId: string | null,
    nextModelId: string,
    saveDefault: boolean,
    explicitEffort?: ReasoningEffort,
  ): Promise<{ savedPath: string | null; backupPath: string | null }> {
    const cleanModel = nextModelId.trim();
    if (!cleanModel) throw new Error("Model ID cannot be empty.");
    const previousEffort = this.modelInfo?.config.reasoningEffort ?? "auto";

    if (explicitProviderId) {
      const targetProv = this.providers.find(
        (p) => p.id === explicitProviderId.toLowerCase(),
      );
      if (!targetProv)
        throw new Error(`Unknown provider "${explicitProviderId}".`);
      if (!targetProv.connected && !targetProv.local) {
        throw new Error(
          `Provider "${targetProv.name}" is not connected. Export ${targetProv.envHint} first.`,
        );
      }
      if (!targetProv.baseUrl) {
        throw new Error(
          `Provider "${targetProv.name}" requires an endpoint URL (${targetProv.envHint}).`,
        );
      }
      this.modelInfo = infoFromProvider(
        targetProv,
        cleanModel,
        this.env,
        this.storedModelConfig,
      );
    } else {
      const currentProvId = this.modelInfo?.config.providerId ?? null;
      const isMultiVendorRouter =
        currentProvId === "openrouter" || currentProvId === "custom";
      const currentProvObj = currentProvId
        ? this.providers.find((p) => p.id === currentProvId)
        : undefined;
      const currentHasModel =
        currentProvObj?.models.some(
          (m) => m.id.toLowerCase() === cleanModel.toLowerCase(),
        ) ?? false;
      const matchedConnected =
        !isMultiVendorRouter && !currentHasModel
          ? this.providers.find(
              (p) =>
                p.connected &&
                p.baseUrl &&
                p.models.some(
                  (m) => m.id.toLowerCase() === cleanModel.toLowerCase(),
                ),
            )
          : undefined;

      if (matchedConnected) {
        this.modelInfo = infoFromProvider(
          matchedConnected,
          cleanModel,
          this.env,
          this.storedModelConfig,
        );
      } else if (this.modelInfo) {
        this.modelInfo = withModelId(this.modelInfo, cleanModel);
      } else {
        this.modelInfo = resolveModelConfig(this.env, cleanModel);
      }
    }

    const nextEffort = explicitEffort ?? previousEffort;
    this.modelInfo = withReasoningEffort(this.modelInfo, nextEffort);

    this.modelError = null;
    this.modelId = this.modelInfo.config.model;
    await this.hydrateActiveCapabilities();
    await this.callbacks.onModelUpdated();
    this.output.ui?.setStatus({
      model: this.modelId,
      modelProvider: this.modelInfo.config.providerId ?? null,
      effort: this.modelInfo.config.reasoningEffort ?? "auto",
    });

    let savedPath: string | null = null;
    let backupPath: string | null = null;
    if (saveDefault) {
      const saved = saveDefaultModelConfig(this.modelInfo, this.env);
      savedPath = saved.path;
      backupPath = saved.backupPath;
      this.storedModelConfig = readStoredModelConfig(this.env);
      this.syncDiscoveredProviders();
    } else if (explicitEffort !== undefined) {
      this.rememberEffort(explicitEffort);
    }
    return { savedPath, backupPath };
  }

  async configureCustomEndpoint(
    rawBaseUrl: string,
    keyOrEnv?: string | null,
    explicitModel?: string | null,
  ): Promise<{
    provider: ResolvedProvider;
    selectedModel: string;
    savedPath: string;
  }> {
    const baseUrl = rawBaseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error(
        `Invalid endpoint URL "${rawBaseUrl}". Expected http:// or https:// base URL.`,
      );
    }
    const existingEnvName =
      this.modelInfo?.config.apiKeyEnv ||
      (typeof this.storedModelConfig?.["api_key_env"] === "string"
        ? String(this.storedModelConfig["api_key_env"]).trim()
        : "") ||
      "OMR_API_KEY";
    let apiKeyEnv = existingEnvName;
    let apiKey =
      this.modelInfo?.config.apiKey ||
      this.env[existingEnvName] ||
      this.env["OMR_API_KEY"] ||
      "";
    let keySource = this.modelInfo?.keySource ?? `env ${apiKeyEnv}`;

    if (keyOrEnv && keyOrEnv.trim()) {
      const trimmedKey = keyOrEnv.trim();
      if (this.env[trimmedKey]) {
        apiKeyEnv = trimmedKey;
        apiKey = this.env[trimmedKey]!;
        keySource = `env ${trimmedKey}`;
      } else if (/^[A-Z][A-Z0-9_]{2,}$/.test(trimmedKey)) {
        apiKeyEnv = trimmedKey;
        apiKey = this.env[trimmedKey] ?? "";
        keySource = `env ${trimmedKey}`;
      } else {
        this.env["OMR_API_KEY"] = trimmedKey;
        apiKeyEnv = "OMR_API_KEY";
        apiKey = trimmedKey;
        keySource = "session OMR_API_KEY";
      }
    }

    const isLocal =
      /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(baseUrl);
    const protocol = inferProtocolFromUrl(baseUrl);
    const probeCandidate: ResolvedProvider = {
      id: "custom",
      name: "Custom / Self-Hosted Endpoint",
      protocol,
      baseUrl,
      apiKey,
      apiKeyEnv,
      keySource: isLocal && !apiKey ? "local (no key)" : keySource,
      envHint: `${apiKeyEnv} + OMR_BASE_URL`,
      headers: {},
      local: isLocal,
      connected: Boolean(apiKey || isLocal),
      models: [],
      liveLoaded: false,
      error: null,
    };

    const refreshed = await fetchProviderModels(probeCandidate);
    const selectedModel = (
      explicitModel?.trim() ||
      refreshed.models[0]?.id ||
      this.modelInfo?.config.model ||
      "default"
    ).trim();

    const nextInfo = infoFromProvider(
      {
        ...refreshed,
        models:
          refreshed.models.length > 0
            ? refreshed.models
            : [
                {
                  id: selectedModel,
                  label: selectedModel,
                  source: "configured",
                },
              ],
      },
      selectedModel,
      this.env,
      this.storedModelConfig,
    );
    this.modelInfo = nextInfo;
    this.modelError = null;
    this.modelId = selectedModel;
    const saved = saveDefaultModelConfig(this.modelInfo, this.env);
    this.storedModelConfig = readStoredModelConfig(this.env);
    this.setBaseProviders(discoverProvidersSync(this.env, this.storedModelConfig).map(
      (p) => (p.id === "custom" ? { ...refreshed, models: refreshed.models.length > 0 ? refreshed.models : p.models } : p),
    ));
    await this.callbacks.onModelUpdated();
    this.output.ui?.setStatus({
      model: this.modelId,
      modelProvider: this.modelInfo.config.providerId ?? null,
      effort: this.modelInfo.config.reasoningEffort ?? "auto",
    });
    return {
      provider:
        this.providers.find((p) => p.id === "custom") ?? refreshed,
      selectedModel,
      savedPath: saved.path,
    };
  }

  /**
   * Remember an effort the user picked so the next launch starts with it. Best effort: a read-only or
   * unwritable config must never break the live selection. Profiles and custom commands do not call this.
   */
  rememberEffort(effort: ReasoningEffort): void {
    try {
      saveReasoningEffortDefault(effort, this.env);
      this.storedModelConfig = readStoredModelConfig(this.env);
    } catch {
      // Selection stays active for this session.
    }
  }

  applyEffortSelection(
    effort: ReasoningEffort,
    saveDefault: boolean,
  ): { savedPath: string | null; backupPath: string | null } {
    if (this.noModel) {
      throw new Error(
        "Thinking effort is disabled when launched with --no-model.",
      );
    }
    if (!this.modelInfo) {
      this.modelInfo = resolveModelConfig(this.env, this.initialModelFlag);
    }
    this.modelInfo = withReasoningEffort(this.modelInfo, effort);
    this.modelError = null;
    this.modelId = this.modelInfo.config.model;
    void this.callbacks.onModelUpdated();
    this.output.ui?.setStatus({
      model: this.modelId,
      modelProvider: this.modelInfo.config.providerId ?? null,
      effort: this.modelInfo.config.reasoningEffort ?? "auto",
    });

    let savedPath: string | null = null;
    let backupPath: string | null = null;
    if (saveDefault) {
      const saved = saveDefaultModelConfig(this.modelInfo, this.env);
      savedPath = saved.path;
      backupPath = saved.backupPath;
      this.storedModelConfig = readStoredModelConfig(this.env);
      this.syncDiscoveredProviders();
    }
    return { savedPath, backupPath };
  }
}
