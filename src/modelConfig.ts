import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  discoverProvidersSync,
  inferProtocolFromUrl,
  type ProviderProtocol,
  type ResolvedProvider,
} from "./providers.js";
import { asNumber, asRecord, asString } from "./values.js";
import type { CapabilityMetadata } from "./capabilities.js";

export type ReasoningEffort =
  | "auto"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface ReasoningEffortSpec {
  readonly id: ReasoningEffort;
  readonly label: string;
  readonly anthropicBudget: number | null;
  readonly description: string;
}

export const REASONING_EFFORT_LEVELS: readonly ReasoningEffortSpec[] =
  Object.freeze([
    {
      id: "auto",
      label: "auto",
      anthropicBudget: null,
      description: "Provider & model default reasoning behavior",
    },
    {
      id: "off",
      label: "off",
      anthropicBudget: null,
      description: "Disable extended thinking for fastest direct replies",
    },
    {
      id: "minimal",
      label: "minimal",
      anthropicBudget: 1024,
      description: "Quickest light thinking check",
    },
    {
      id: "low",
      label: "low",
      anthropicBudget: 2048,
      description: "Light reasoning for fast triage",
    },
    {
      id: "medium",
      label: "medium",
      anthropicBudget: 8192,
      description: "Balanced reasoning depth",
    },
    {
      id: "high",
      label: "high",
      anthropicBudget: 16384,
      description: "Deep multi-step binary analysis",
    },
    {
      id: "xhigh",
      label: "xhigh",
      anthropicBudget: 32000,
      description: "Maximum reasoning depth",
    },
  ]);

export const parseReasoningEffort = (raw: unknown): ReasoningEffort | null => {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "none") return "off";
  if (normalized === "max") return "xhigh";
  const hit = REASONING_EFFORT_LEVELS.find((lvl) => lvl.id === normalized);
  return hit ? hit.id : null;
};

export interface ModelConfig {
  capabilities?: CapabilityMetadata;
  modelMetadata?: CapabilityMetadata;
  providerId?: string;
  providerName?: string;
  protocol?: ProviderProtocol;
  headers?: Readonly<Record<string, string>>;
  reasoningEffort?: ReasoningEffort;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyEnv: string;
  maxTokens: number;
  temperature: number | null;
  maxSteps: number;
  /**
   * How many times the step budget may be extended by another `maxSteps` when the model is still making
   * progress (successful tool calls) as the budget runs out. `0` disables auto-extension.
   */
  autoExtendSteps?: number;
  timeoutMs: number;
  /** Base interval (ms) between connectivity probes during a network outage. */
  pingIntervalMs?: number;
  /** Maximum total duration (ms) to hold the session waiting for network recovery before failing. */
  maxNetworkWaitMs?: number;
  /** Ordered list of fallback `[provider:]model` specs tried automatically when the primary endpoint fails. */
  fallbackModels?: readonly string[];
  /** Optional session token budget cap (`OMR_BUDGET_TOKENS` / `/budget`); `null` or `undefined` means unlimited. */
  budgetTokens?: number | null;
  /** Optional custom connectivity probe (defaults to DNS + TCP handshake against `baseUrl`). */
  networkProbe?: (
    baseUrl: string,
    signal?: AbortSignal,
  ) => Promise<{ ok: boolean; latencyMs: number; reason?: string }>;
  /** Optional listener notified when Network Guard pauses, pings, or restores the session. */
  onNetworkStatus?: (notice: {
    readonly state: "offline" | "pinging" | "restored";
    readonly target: string;
    readonly attempt: number;
    readonly reason: string;
    readonly offlineDurationMs: number;
    readonly nextPingInMs: number | null;
    readonly latencyMs: number | null;
  }) => void;
}

export interface ModelConfigInfo {
  config: ModelConfig;
  file: string | null;
  keySource: string;
}

const CONFIG_NAME = "omr-model.json";

export const modelConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(
    env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
    "rea",
    CONFIG_NAME,
  );

export const readStoredModelConfig = (
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(modelConfigPath(env), "utf8"),
    );
    return asRecord(parsed);
  } catch {
    return null;
  }
};

const DEFAULT_AUTO_EXTEND_STEPS = 50;

const envPositiveInt = (raw: string | undefined): number | null => {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : null;
};

const envFiniteNumber = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse a human-friendly token budget specification (`"500k"`, `"2m"`, `"250000"`, `500000`).
 * Returns `null` when unset, `"off"`, `"none"`, `"0"`, or invalid.
 */
export const parseTokenBudgetSpec = (raw: unknown): number | null => {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : null;
  }
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toLowerCase().replace(/[,_]/g, "");
  if (
    !cleaned ||
    cleaned === "off" ||
    cleaned === "none" ||
    cleaned === "unlimited" ||
    cleaned === "0"
  ) {
    return null;
  }
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(cleaned);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const suffix = (match[2] ?? "").toLowerCase();
  const mult = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  const total = Math.trunc(base * mult);
  return total >= 1 ? total : null;
};

/** Parse comma- or whitespace-separated `[provider:]model` fallback specs or string arrays. */
export const parseFallbackModelsSpec = (raw: unknown): string[] => {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0 && item.toLowerCase() !== "off");
  }
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.toLowerCase() === "off" ||
    trimmed.toLowerCase() === "none" ||
    trimmed.toLowerCase() === "clear"
  ) {
    return [];
  }
  return trimmed
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

/**
 * Estimate cumulative session API cost in USD from total tokens and model family.
 * Uses blended input/output rates ($/1M tokens) for common frontier/coding/fast models.
 */
export const estimateSessionCostUsd = (
  modelId: string,
  totalTokens: number,
): number => {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return 0;
  const lower = modelId.toLowerCase();
  let perMillionUsd = 3.0;
  if (
    lower.includes("ollama") ||
    lower.includes("lmstudio") ||
    lower.includes("llamacpp") ||
    lower.includes("vllm")
  ) {
    perMillionUsd = 0;
  } else if (lower.includes("opus") || lower.includes("gpt-4.5") || lower.includes("o1-pro")) {
    perMillionUsd = 18.0;
  } else if (
    lower.includes("sonnet") ||
    lower.includes("gpt-4o") ||
    lower.includes("gpt-4.1") ||
    lower.includes("gpt-5") ||
    lower.includes("gemini-2.5-pro") ||
    lower.includes("grok-3")
  ) {
    perMillionUsd = 4.5;
  } else if (
    lower.includes("haiku") ||
    lower.includes("mini") ||
    lower.includes("flash") ||
    lower.includes("deepseek") ||
    lower.includes("qwen")
  ) {
    perMillionUsd = 0.6;
  }
  return Number(((totalTokens / 1_000_000) * perMillionUsd).toFixed(4));
};

/**
 * Parse optional `providerId:modelId` syntax only when `providerId` matches a known
 * discovered provider ID (preserving Ollama `:tag` model names like `qwen3:32b` and
 * `/` router model names like `deepseek-ai/DeepSeek-V4.1`).
 */
export const splitProviderModelSpec = (
  spec: string,
  providers: readonly ResolvedProvider[],
): { providerId: string | null; modelId: string } => {
  const trimmed = spec.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return { providerId: null, modelId: trimmed };
  const candidateProvider = trimmed.slice(0, colon).toLowerCase();
  const restModel = trimmed.slice(colon + 1).trim();
  if (!restModel) return { providerId: null, modelId: trimmed };
  if (providers.some((p) => p.id === candidateProvider)) {
    return { providerId: candidateProvider, modelId: restModel };
  }
  return { providerId: null, modelId: trimmed };
};

const limitsFrom = (
  env: NodeJS.ProcessEnv,
  stored: Record<string, unknown> | null,
) => {
  const maxTokens =
    envPositiveInt(env["OMR_MAX_TOKENS"]) ??
    asNumber(stored?.["max_tokens"]) ??
    8192;
  const maxSteps =
    envPositiveInt(env["OMR_MAX_STEPS"]) ??
    asNumber(stored?.["max_steps"]) ??
    40;
  const timeoutMs =
    envPositiveInt(env["OMR_TIMEOUT_MS"]) ??
    asNumber(stored?.["timeout_ms"]) ??
    600_000;
  const temperature =
    envFiniteNumber(env["OMR_TEMPERATURE"]) ??
    asNumber(stored?.["temperature"]);
  const reasoningEffort: ReasoningEffort =
    parseReasoningEffort(env["OMR_EFFORT"] ?? env["OMR_REASONING_EFFORT"]) ??
    parseReasoningEffort(stored?.["reasoning_effort"]) ??
    "auto";
  const pingIntervalMs =
    envPositiveInt(env["OMR_PING_INTERVAL_MS"]) ??
    asNumber(stored?.["ping_interval_ms"]);
  const maxNetworkWaitMs =
    envPositiveInt(env["OMR_NET_WAIT_MS"]) ??
    asNumber(stored?.["max_network_wait_ms"]);
  const autoExtendSteps =
    envFiniteNumber(env["OMR_AUTO_EXTEND_STEPS"]) ??
    asNumber(stored?.["auto_extend_steps"]) ??
    DEFAULT_AUTO_EXTEND_STEPS;
  const fallbackModels =
    env["OMR_FALLBACK_MODELS"] !== undefined
      ? parseFallbackModelsSpec(env["OMR_FALLBACK_MODELS"])
      : parseFallbackModelsSpec(stored?.["fallback_models"]);
  const budgetTokens =
    env["OMR_BUDGET_TOKENS"] !== undefined
      ? parseTokenBudgetSpec(env["OMR_BUDGET_TOKENS"])
      : parseTokenBudgetSpec(stored?.["budget_tokens"]);
  return {
    maxTokens: Math.max(64, Math.trunc(maxTokens)),
    maxSteps: Math.max(1, Math.trunc(maxSteps)),
    autoExtendSteps: Math.max(0, Math.min(1_000, Math.trunc(autoExtendSteps))),
    timeoutMs: Math.max(1_000, Math.trunc(timeoutMs)),
    temperature,
    reasoningEffort,
    ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
    ...(budgetTokens !== null ? { budgetTokens } : {}),
    ...(pingIntervalMs !== null && pingIntervalMs > 0
      ? { pingIntervalMs: Math.trunc(pingIntervalMs) }
      : {}),
    ...(maxNetworkWaitMs !== null && maxNetworkWaitMs > 0
      ? { maxNetworkWaitMs: Math.trunc(maxNetworkWaitMs) }
      : {}),
  };
};

export const infoFromProvider = (
  provider: ResolvedProvider,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
  stored: Record<string, unknown> | null = readStoredModelConfig(env),
): ModelConfigInfo => {
  const limits = limitsFrom(env, stored);
  const file = modelConfigPath(env);
  return {
    config: {
      providerId: provider.id,
      providerName: provider.name,
      protocol: provider.protocol,
      headers: provider.headers,
      baseUrl: provider.baseUrl,
      model: modelId.trim(),
      apiKey: provider.apiKey,
      apiKeyEnv: provider.apiKeyEnv,
      ...limits,
    },
    file: stored ? file : null,
    keySource: provider.keySource,
  };
};

/**
 * Resolve active model configuration from `omr-model.json`, `OMR_*` overrides,
 * explicit `provider:model` / `model` override, or the first connected provider
 * discovered in the environment.
 */
export const resolveModelConfig = (
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string | null,
): ModelConfigInfo => {
  const file = modelConfigPath(env);
  const stored = readStoredModelConfig(env);
  const providers = discoverProvidersSync(env, stored);
  const limits = limitsFrom(env, stored);

  // 1. Explicit `providerId:modelId` override
  if (modelOverride?.trim()) {
    const parsed = splitProviderModelSpec(modelOverride, providers);
    if (parsed.providerId) {
      const targetProvider = providers.find((p) => p.id === parsed.providerId);
      if (!targetProvider) {
        throw new Error(`Unknown provider "${parsed.providerId}".`);
      }
      if (!targetProvider.connected && !targetProvider.local) {
        throw new Error(
          `Provider "${targetProvider.name}" is not connected. Export ${targetProvider.envHint} first.`,
        );
      }
      if (!targetProvider.baseUrl) {
        throw new Error(
          `Provider "${targetProvider.name}" has no base URL (${targetProvider.envHint}).`,
        );
      }
      return infoFromProvider(targetProvider, parsed.modelId, env, stored);
    }
  }

  // 2. Stored config / OMR_* explicit base_url path (100% backwards-compatible)
  const explicitProviderId = (
    env["OMR_PROVIDER"] ?? asString(stored?.["provider"])
  )
    .trim()
    .toLowerCase();
  if (explicitProviderId) {
    const namedProv = providers.find((p) => p.id === explicitProviderId);
    if (
      namedProv &&
      (namedProv.connected || namedProv.local) &&
      namedProv.baseUrl
    ) {
      const chosenModel = (
        modelOverride?.trim() ||
        env["OMR_MODEL"] ||
        asString(stored?.["model"]) ||
        namedProv.models[0]?.id ||
        ""
      ).trim();
      if (chosenModel) {
        return infoFromProvider(namedProv, chosenModel, env, stored);
      }
    }
  }

  const baseUrl = (
    env["OMR_BASE_URL"] ?? asString(stored?.["base_url"])
  ).trim();
  if (baseUrl) {
    const model = (
      modelOverride?.trim() ||
      env["OMR_MODEL"] ||
      asString(stored?.["model"])
    ).trim();
    const apiKeyEnv = (
      env["OMR_API_KEY_ENV"] ?? asString(stored?.["api_key_env"])
    ).trim();
    const directKey = env["OMR_API_KEY"] ?? asString(stored?.["api_key"]);
    const namedKey = apiKeyEnv ? env[apiKeyEnv] : undefined;
    const matched = providers.find(
      (p) =>
        p.baseUrl.toLowerCase() === baseUrl.replace(/\/+$/, "").toLowerCase(),
    );
    const isLocal =
      matched?.local === true ||
      /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(baseUrl);
    const apiKey =
      directKey || namedKey || matched?.apiKey || env["OPENAI_API_KEY"] || "";
    const keySource = directKey
      ? env["OMR_API_KEY"]
        ? "env OMR_API_KEY"
        : "config api_key"
      : namedKey
        ? `env ${apiKeyEnv}`
        : matched?.apiKey
          ? matched.keySource
          : env["OPENAI_API_KEY"]
            ? "env OPENAI_API_KEY"
            : isLocal
              ? "local (no key)"
              : "missing";

    if (!model) {
      throw new Error(
        `No model id. Set "model" in ${file}, OMR_MODEL, or --model <id>.`,
      );
    }
    if (!apiKey && !isLocal) {
      throw new Error(
        `No API key. Set "api_key_env" in ${file} to an exported variable, or OMR_API_KEY.`,
      );
    }

    const protocol = inferProtocolFromUrl(
      baseUrl,
      env["OMR_PROTOCOL"] ??
        asString(stored?.["protocol"]) ??
        matched?.protocol,
    );

    return {
      config: {
        providerId: matched?.id ?? "custom",
        providerName: matched?.name ?? "Custom Endpoint",
        protocol,
        headers: matched?.headers ?? {},
        baseUrl: baseUrl.replace(/\/+$/, ""),
        model,
        apiKey,
        apiKeyEnv: apiKeyEnv || matched?.apiKeyEnv || "OMR_API_KEY",
        ...limits,
      },
      file: stored ? file : null,
      keySource,
    };
  }

  // 3. Zero-config auto-detection from connected providers in environment
  const firstConnected = providers.find((p) => p.connected && p.baseUrl);
  if (firstConnected) {
    const model = (
      modelOverride?.trim() ||
      env["OMR_MODEL"]?.trim() ||
      firstConnected.models[0]?.id ||
      ""
    ).trim();
    if (model) {
      return infoFromProvider(firstConnected, model, env, stored);
    }
  }

  throw new Error(
    `No connected model provider. Export an API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY, …), write ${file}, or use /model in TUI.`,
  );
};

export const withModelId = (
  info: ModelConfigInfo,
  nextModel: string,
): ModelConfigInfo => ({
  ...info,
  config: {
    ...info.config,
    model: nextModel.trim(),
  },
});

export const withReasoningEffort = (
  info: ModelConfigInfo,
  effort: ReasoningEffort,
): ModelConfigInfo => ({
  ...info,
  config: {
    ...info.config,
    reasoningEffort: effort,
  },
});

/**
 * Additively persist default provider & model to `~/.config/rea/omr-model.json`
 * with an automatic `.bak` backup if the file already exists. Never writes raw
 * secret keys from environment variables to disk.
 */
export const saveDefaultModelConfig = (
  info: ModelConfigInfo,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; backupPath: string | null } => {
  const path = modelConfigPath(env);
  const existing = readStoredModelConfig(env) ?? {};
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  let backupPath: string | null = null;
  if (existsSync(path)) {
    backupPath = `${path}.bak`;
    copyFileSync(path, backupPath);
  }

  const next: Record<string, unknown> = {
    ...existing,
    provider: info.config.providerId ?? "custom",
    protocol: info.config.protocol ?? "openai-chat",
    base_url: info.config.baseUrl,
    model: info.config.model,
    api_key_env: info.config.apiKeyEnv,
    reasoning_effort: info.config.reasoningEffort ?? "auto",
    max_tokens: info.config.maxTokens,
    max_steps: info.config.maxSteps,
  };
  // Write-then-rename so a crash mid-write can never leave a truncated config behind.
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(staging, path);
  return { path, backupPath };
};

/**
 * Remember the user's thinking-effort choice for the next launch by updating only `reasoning_effort`
 * in `~/.config/rea/omr-model.json` (atomic write, every other key kept, no per-change backup noise).
 */
export const saveReasoningEffortDefault = (
  effort: ReasoningEffort,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const path = modelConfigPath(env);
  const existing = readStoredModelConfig(env) ?? {};
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(
    staging,
    `${JSON.stringify({ ...existing, reasoning_effort: effort }, null, 2)}\n`,
    { mode: 0o600 },
  );
  renameSync(staging, path);
  return path;
};

/**
 * Additively persist runtime resilience/budget settings (`fallback_models`, `budget_tokens`,
 * `ping_interval_ms`, `max_network_wait_ms`) to `~/.config/rea/omr-model.json` with `.bak` backup.
 */
export const saveModelRuntimeSettings = (
  patch: {
    readonly fallbackModels?: readonly string[] | undefined;
    readonly budgetTokens?: number | null | undefined;
    readonly pingIntervalMs?: number | undefined;
    readonly maxNetworkWaitMs?: number | undefined;
  },
  env: NodeJS.ProcessEnv = process.env,
): { path: string; backupPath: string | null } => {
  const path = modelConfigPath(env);
  const existing = readStoredModelConfig(env) ?? {};
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  let backupPath: string | null = null;
  if (existsSync(path)) {
    backupPath = `${path}.bak`;
    copyFileSync(path, backupPath);
  }

  const next: Record<string, unknown> = { ...existing };
  if (patch.fallbackModels !== undefined) {
    if (patch.fallbackModels.length > 0) {
      next["fallback_models"] = [...patch.fallbackModels];
    } else {
      delete next["fallback_models"];
    }
  }
  if (patch.budgetTokens !== undefined) {
    if (patch.budgetTokens !== null && patch.budgetTokens > 0) {
      next["budget_tokens"] = patch.budgetTokens;
    } else {
      delete next["budget_tokens"];
    }
  }
  if (patch.pingIntervalMs !== undefined && patch.pingIntervalMs > 0) {
    next["ping_interval_ms"] = Math.trunc(patch.pingIntervalMs);
  }
  if (patch.maxNetworkWaitMs !== undefined && patch.maxNetworkWaitMs > 0) {
    next["max_network_wait_ms"] = Math.trunc(patch.maxNetworkWaitMs);
  }

  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(staging, path);
  return { path, backupPath };
};
