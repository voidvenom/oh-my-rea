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
  saveModelRuntimeSettings,
  splitProviderModelSpec,
  withModelId,
  withReasoningEffort,
  type ModelConfig,
  type ModelConfigInfo,
  type ReasoningEffort,
} from "../modelConfig.js";
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
  providers: readonly ResolvedProvider[];
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
    this.providers = discoverProvidersSync(env, this.storedModelConfig);

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
      const timeout = AbortSignal.timeout(6_000);
      state.refreshed = await fetchProviderModels(provider, signal ? AbortSignal.any([signal, timeout]) : timeout);
      return state.refreshed.models.find((candidate) => candidate.id === config.model)?.capabilities;
    };
    const resolved = await resolveLimits(providerId, config.baseUrl, config.model, { env: this.env, live, ...(signal ? { signal } : {}) });
    const metadata = resolved?.metadata;
    this.providers = this.providers.map((candidate) => {
      if (candidate.id !== providerId) return candidate;
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
      const msg = `model failover: ${notice.from} → ${notice.to} (${notice.reason})`;
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
    const prevById = new Map(this.providers.map((p) => [p.id, p]));
    const fresh = discoverProvidersSync(this.env, this.storedModelConfig);
    this.providers = fresh.map((p) => {
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
    });
  }

  async triggerProvidersRefresh(
    force = false,
  ): Promise<readonly ResolvedProvider[]> {
    if (this.providersRefreshing) return this.providers;
    const anyConnectedPending = this.providers.some(
      (p) => p.connected && !p.local && !p.liveLoaded,
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
        : this.providers;
      this.providers = await refreshAllProviders(toRefresh);
      const allConnectedLoaded = this.providers
        .filter((p) => p.connected && !p.local)
        .every((p) => p.liveLoaded);
      this.providersRefreshedOnce = allConnectedLoaded;
      const errProv = this.providers.find(
        (p) => p.connected && !p.local && p.error,
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

  openInteractiveModelPicker(focusProviderId?: string | null): void {
    const ui = this.output.ui;
    if (!ui) return;
    if (this.noModel) {
      ui.showOutput(
        "model",
        "model switching is disabled when launched with --no-model",
      );
      return;
    }
    this.storedModelConfig = readStoredModelConfig(this.env);
    this.syncDiscoveredProviders();
    const needsRefresh =
      !this.providersRefreshedOnce ||
      this.providers.some((p) => p.connected && !p.local && !p.liveLoaded);
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
  }

  openInteractiveEffortPicker(): void {
    const ui = this.output.ui;
    if (!ui) return;
    if (this.noModel) {
      ui.showOutput(
        "effort",
        "thinking effort is disabled when launched with --no-model",
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
        "compaction model selection is disabled when launched with --no-model",
      );
      return;
    }
    this.storedModelConfig = readStoredModelConfig(this.env);
    if (!this.providersRefreshedOnce) {
      this.providers = discoverProvidersSync(this.env, this.storedModelConfig);
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
    this.providers = discoverProvidersSync(this.env, this.storedModelConfig).map(
      (p) => (p.id === "custom" ? { ...refreshed, models: refreshed.models.length > 0 ? refreshed.models : p.models } : p),
    );
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
