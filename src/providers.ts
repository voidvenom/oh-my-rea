import { asArray, asRecord, asString } from "./values.js";
import { parseCapabilityMetadata, type CapabilityMetadata } from "./capabilities.js";
import { sameEndpoint, validateCustomBaseUrl } from "./customEndpoint.js";

export type ProviderProtocol = "openai-chat" | "anthropic-messages";

export interface ProviderModelItem {
  readonly id: string;
  readonly label: string;
  readonly source: "configured" | "live" | "curated";
  readonly note?: string;
  readonly capabilities?: CapabilityMetadata;
}

export interface ProviderCatalogSpec {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly defaultBaseUrl: string;
  readonly baseUrlEnv?: string;
  readonly apiKeyEnvs: readonly string[];
  readonly envHint: string;
  readonly local?: boolean;
  readonly curatedModels: readonly string[];
  readonly buildHeaders?: (apiKey: string) => Record<string, string>;
  readonly resolveBaseUrl?: (env: NodeJS.ProcessEnv) => string | null;
}

export type RouterProduct = "9router" | "omniroute";
export const ROUTER_PRODUCTS: Readonly<Record<RouterProduct, { readonly name: string; readonly baseUrlEnv: string; readonly apiKeyEnv: string }>> = {
  "9router": { name: "9Router", baseUrlEnv: "OMR_9ROUTER_BASE_URL", apiKeyEnv: "OMR_9ROUTER_API_KEY" },
  omniroute: { name: "OmniRoute", baseUrlEnv: "OMR_OMNIROUTE_BASE_URL", apiKeyEnv: "OMR_OMNIROUTE_API_KEY" },
};
export type CatalogStatus =
  | "loading" | "ok" | "partial" | "empty" | "auth-required" | "denied" | "api-not-found"
  | "malformed" | "too-large" | "redirect" | "timeout" | "unreachable" | "http-error" | "offline";
export type ProviderProvenance = "builtin" | "config" | "config-named" | "env-router" | "detected" | "session";

export interface ResolvedProvider {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly connected: boolean;
  readonly local: boolean;
  readonly apiKey: string;
  readonly apiKeyEnv: string;
  readonly keySource: string;
  readonly envHint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly models: readonly ProviderModelItem[];
  readonly liveLoaded: boolean;
  readonly error: string | null;
  readonly provenance?: ProviderProvenance;
  readonly product?: RouterProduct;
  readonly catalogStatus?: CatalogStatus;
  readonly httpStatus?: number;
}

export const BUILTIN_PROVIDERS: readonly ProviderCatalogSpec[] = Object.freeze([
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.openai.com/v1",
    baseUrlEnv: "OPENAI_BASE_URL",
    apiKeyEnvs: ["OPENAI_API_KEY"],
    envHint: "OPENAI_API_KEY",
    curatedModels: [
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "o3",
      "o4-mini",
      "gpt-4o",
      "gpt-4o-mini",
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    protocol: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    apiKeyEnvs: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
    envHint: "ANTHROPIC_API_KEY",
    curatedModels: [
      "claude-sonnet-4-5",
      "claude-opus-4-5",
      "claude-haiku-4-5",
      "claude-3-7-sonnet-latest",
      "claude-3-5-sonnet-latest",
      "claude-3-5-haiku-latest",
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    protocol: "openai-chat",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    baseUrlEnv: "GEMINI_BASE_URL",
    apiKeyEnvs: [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
    ],
    envHint: "GEMINI_API_KEY",
    curatedModels: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai-chat",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    apiKeyEnvs: ["OPENROUTER_API_KEY"],
    envHint: "OPENROUTER_API_KEY",
    buildHeaders: () => ({
      "HTTP-Referer": "https://github.com/rea/omr",
      "X-Title": "oh-my-rea",
    }),
    curatedModels: [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-4.1",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-chat-v3-0324",
      "deepseek/deepseek-r1",
      "qwen/qwen3-coder",
      "x-ai/grok-4",
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    apiKeyEnvs: ["DEEPSEEK_API_KEY"],
    envHint: "DEEPSEEK_API_KEY",
    curatedModels: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.x.ai/v1",
    baseUrlEnv: "XAI_BASE_URL",
    apiKeyEnvs: ["XAI_API_KEY", "GROK_API_KEY"],
    envHint: "XAI_API_KEY",
    curatedModels: ["grok-4", "grok-3", "grok-3-mini", "grok-code-fast-1"],
  },
  {
    id: "groq",
    name: "Groq LPU",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    baseUrlEnv: "GROQ_BASE_URL",
    apiKeyEnvs: ["GROQ_API_KEY"],
    envHint: "GROQ_API_KEY",
    curatedModels: [
      "moonshotai/kimi-k2-instruct",
      "qwen/qwen3-32b",
      "deepseek-r1-distill-llama-70b",
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
    ],
  },
  {
    id: "mistral",
    name: "Mistral / Codestral",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    baseUrlEnv: "MISTRAL_BASE_URL",
    apiKeyEnvs: ["MISTRAL_API_KEY"],
    envHint: "MISTRAL_API_KEY",
    curatedModels: [
      "mistral-large-latest",
      "codestral-latest",
      "magistral-medium-latest",
      "mistral-medium-latest",
      "ministral-8b-latest",
    ],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    baseUrlEnv: "CEREBRAS_BASE_URL",
    apiKeyEnvs: ["CEREBRAS_API_KEY"],
    envHint: "CEREBRAS_API_KEY",
    curatedModels: [
      "qwen-3-coder-480b",
      "qwen-3-235b-a22b",
      "llama-3.3-70b",
      "llama3.1-8b",
    ],
  },
  {
    id: "sambanova",
    name: "SambaNova",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.sambanova.ai/v1",
    baseUrlEnv: "SAMBANOVA_BASE_URL",
    apiKeyEnvs: ["SAMBANOVA_API_KEY"],
    envHint: "SAMBANOVA_API_KEY",
    curatedModels: [
      "DeepSeek-V3-0324",
      "DeepSeek-R1",
      "Meta-Llama-3.3-70B-Instruct",
      "Qwen3-32B",
    ],
  },
  {
    id: "together",
    name: "Together AI",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.together.xyz/v1",
    baseUrlEnv: "TOGETHER_BASE_URL",
    apiKeyEnvs: ["TOGETHER_API_KEY", "TOGETHERAI_API_KEY"],
    envHint: "TOGETHER_API_KEY",
    curatedModels: [
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-R1",
      "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    ],
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    baseUrlEnv: "FIREWORKS_BASE_URL",
    apiKeyEnvs: ["FIREWORKS_API_KEY"],
    envHint: "FIREWORKS_API_KEY",
    curatedModels: [
      "accounts/fireworks/models/deepseek-v3",
      "accounts/fireworks/models/deepseek-r1",
      "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct",
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
    ],
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
    baseUrlEnv: "DEEPINFRA_BASE_URL",
    apiKeyEnvs: ["DEEPINFRA_API_KEY", "DEEPINFRA_TOKEN"],
    envHint: "DEEPINFRA_API_KEY",
    curatedModels: [
      "deepseek-ai/DeepSeek-V3-0324",
      "deepseek-ai/DeepSeek-R1",
      "Qwen/Qwen3-235B-A22B",
      "meta-llama/Llama-3.3-70B-Instruct",
    ],
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.siliconflow.com/v1",
    baseUrlEnv: "SILICONFLOW_BASE_URL",
    apiKeyEnvs: ["SILICONFLOW_API_KEY"],
    envHint: "SILICONFLOW_API_KEY",
    curatedModels: [
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-R1",
      "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "Qwen/Qwen3-235B-A22B",
    ],
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    protocol: "openai-chat",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    baseUrlEnv: "NVIDIA_BASE_URL",
    apiKeyEnvs: ["NVIDIA_API_KEY", "NGC_API_KEY"],
    envHint: "NVIDIA_API_KEY",
    curatedModels: [
      "deepseek-ai/deepseek-r1",
      "nvidia/llama-3.1-nemotron-ultra-253b-v1",
      "meta/llama-3.3-70b-instruct",
      "qwen/qwen2.5-coder-32b-instruct",
    ],
  },
  {
    id: "qwen",
    name: "Alibaba Qwen (DashScope)",
    protocol: "openai-chat",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    apiKeyEnvs: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
    envHint: "DASHSCOPE_API_KEY",
    curatedModels: [
      "qwen3-coder-plus",
      "qwen3-235b-a22b",
      "qwen-max",
      "qwen-plus",
      "qwq-plus",
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot AI (Kimi)",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    baseUrlEnv: "MOONSHOT_BASE_URL",
    apiKeyEnvs: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
    envHint: "MOONSHOT_API_KEY",
    curatedModels: ["kimi-k2-0711-preview", "kimi-latest", "moonshot-v1-128k"],
  },
  {
    id: "zhipu",
    name: "Z.ai / Zhipu GLM",
    protocol: "openai-chat",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    baseUrlEnv: "ZHIPU_BASE_URL",
    apiKeyEnvs: ["ZHIPU_API_KEY", "GLM_API_KEY", "ZAI_API_KEY"],
    envHint: "ZHIPU_API_KEY",
    curatedModels: ["glm-4.6", "glm-4.5", "glm-4.5-air", "glm-4-plus"],
  },
  {
    id: "minimax",
    name: "MiniMax",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.minimax.io/v1",
    baseUrlEnv: "MINIMAX_BASE_URL",
    apiKeyEnvs: ["MINIMAX_API_KEY"],
    envHint: "MINIMAX_API_KEY",
    curatedModels: ["MiniMax-M2", "MiniMax-M1", "MiniMax-Text-01"],
  },
  {
    id: "cohere",
    name: "Cohere",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.cohere.ai/compatibility/v1",
    baseUrlEnv: "COHERE_BASE_URL",
    apiKeyEnvs: ["COHERE_API_KEY", "CO_API_KEY"],
    envHint: "COHERE_API_KEY",
    curatedModels: [
      "command-a-03-2025",
      "command-r-plus-08-2024",
      "command-r-08-2024",
    ],
  },
  {
    id: "perplexity",
    name: "Perplexity",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.perplexity.ai",
    baseUrlEnv: "PERPLEXITY_BASE_URL",
    apiKeyEnvs: ["PERPLEXITY_API_KEY", "PPLX_API_KEY"],
    envHint: "PERPLEXITY_API_KEY",
    curatedModels: ["sonar-reasoning-pro", "sonar-pro", "sonar"],
  },
  {
    id: "github",
    name: "GitHub Models",
    protocol: "openai-chat",
    defaultBaseUrl: "https://models.github.ai/inference",
    baseUrlEnv: "GITHUB_MODELS_BASE_URL",
    apiKeyEnvs: ["GITHUB_MODELS_TOKEN", "GITHUB_TOKEN"],
    envHint: "GITHUB_MODELS_TOKEN",
    curatedModels: [
      "openai/gpt-4.1",
      "openai/gpt-4.1-mini",
      "openai/o4-mini",
      "deepseek/DeepSeek-V3-0324",
      "xai/grok-3",
    ],
  },
  {
    id: "huggingface",
    name: "Hugging Face Router",
    protocol: "openai-chat",
    defaultBaseUrl: "https://router.huggingface.co/v1",
    baseUrlEnv: "HF_BASE_URL",
    apiKeyEnvs: ["HF_TOKEN", "HUGGINGFACE_API_KEY", "HUGGINGFACEHUB_API_TOKEN"],
    envHint: "HF_TOKEN",
    curatedModels: [
      "deepseek-ai/DeepSeek-V3-0324",
      "Qwen/Qwen3-235B-A22B",
      "meta-llama/Llama-3.3-70B-Instruct",
    ],
  },
  {
    id: "novita",
    name: "Novita AI",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.novita.ai/v3/openai",
    baseUrlEnv: "NOVITA_BASE_URL",
    apiKeyEnvs: ["NOVITA_API_KEY"],
    envHint: "NOVITA_API_KEY",
    curatedModels: [
      "deepseek/deepseek-v3-0324",
      "deepseek/deepseek-r1",
      "qwen/qwen3-235b-a22b-fp8",
    ],
  },
  {
    id: "hyperbolic",
    name: "Hyperbolic",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.hyperbolic.xyz/v1",
    baseUrlEnv: "HYPERBOLIC_BASE_URL",
    apiKeyEnvs: ["HYPERBOLIC_API_KEY"],
    envHint: "HYPERBOLIC_API_KEY",
    curatedModels: [
      "deepseek-ai/DeepSeek-V3-0324",
      "deepseek-ai/DeepSeek-R1",
      "Qwen/Qwen2.5-Coder-32B-Instruct",
    ],
  },
  {
    id: "chutes",
    name: "Chutes AI",
    protocol: "openai-chat",
    defaultBaseUrl: "https://llm.chutes.ai/v1",
    baseUrlEnv: "CHUTES_BASE_URL",
    apiKeyEnvs: ["CHUTES_API_KEY"],
    envHint: "CHUTES_API_KEY",
    curatedModels: ["deepseek-ai/DeepSeek-V3-0324", "deepseek-ai/DeepSeek-R1"],
  },
  {
    id: "azure",
    name: "Azure OpenAI",
    protocol: "openai-chat",
    defaultBaseUrl: "",
    baseUrlEnv: "AZURE_OPENAI_BASE_URL",
    apiKeyEnvs: ["AZURE_OPENAI_API_KEY"],
    envHint: "AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY",
    resolveBaseUrl: (env) => {
      const direct = env["AZURE_OPENAI_BASE_URL"]?.trim();
      if (direct) return direct.replace(/\/+$/, "");
      const endpoint = env["AZURE_OPENAI_ENDPOINT"]?.trim();
      if (!endpoint) return null;
      return `${endpoint.replace(/\/+$/, "")}/openai/v1`;
    },
    buildHeaders: (apiKey) => (apiKey ? { "api-key": apiKey } : {}),
    curatedModels: ["gpt-4.1", "gpt-4o", "o4-mini"],
  },
  {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    protocol: "openai-chat",
    defaultBaseUrl: "",
    apiKeyEnvs: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY"],
    envHint: "CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN",
    resolveBaseUrl: (env) => {
      const accountId = env["CLOUDFLARE_ACCOUNT_ID"]?.trim();
      if (!accountId) return null;
      return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
    },
    curatedModels: [
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "@cf/qwen/qwen2.5-coder-32b-instruct",
    ],
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    protocol: "openai-chat",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    baseUrlEnv: "OLLAMA_BASE_URL",
    apiKeyEnvs: ["OLLAMA_API_KEY"],
    envHint: "ollama serve (127.0.0.1:11434)",
    local: true,
    resolveBaseUrl: (env) => {
      const explicit = env["OLLAMA_BASE_URL"]?.trim();
      if (explicit) return explicit.replace(/\/+$/, "");
      const host = env["OLLAMA_HOST"]?.trim();
      if (!host) return "http://127.0.0.1:11434/v1";
      const withProto = /^https?:\/\//i.test(host) ? host : `http://${host}`;
      return `${withProto.replace(/\/+$/, "").replace(/\/v1$/i, "")}/v1`;
    },
    curatedModels: [
      "qwen3:32b",
      "qwen2.5-coder:32b",
      "deepseek-r1:32b",
      "llama3.3:70b",
      "gemma3:27b",
    ],
  },
  {
    id: "lmstudio",
    name: "LM Studio (Local)",
    protocol: "openai-chat",
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    baseUrlEnv: "LMSTUDIO_BASE_URL",
    apiKeyEnvs: ["LMSTUDIO_API_KEY"],
    envHint: "LM Studio server (127.0.0.1:1234)",
    local: true,
    curatedModels: [
      "qwen2.5-coder-32b-instruct",
      "deepseek-r1-distill-qwen-32b",
    ],
  },
  {
    id: "vllm",
    name: "vLLM (Local)",
    protocol: "openai-chat",
    defaultBaseUrl: "http://127.0.0.1:8000/v1",
    baseUrlEnv: "VLLM_BASE_URL",
    apiKeyEnvs: ["VLLM_API_KEY"],
    envHint: "vllm serve (127.0.0.1:8000)",
    local: true,
    curatedModels: [],
  },
  {
    id: "llamacpp",
    name: "llama.cpp (Local)",
    protocol: "openai-chat",
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
    baseUrlEnv: "LLAMACPP_BASE_URL",
    apiKeyEnvs: ["LLAMACPP_API_KEY"],
    envHint: "llama-server (127.0.0.1:8080)",
    local: true,
    curatedModels: [],
  },
  {
    id: "localai",
    name: "LocalAI / Jan (Local)",
    protocol: "openai-chat",
    defaultBaseUrl: "http://127.0.0.1:8081/v1",
    baseUrlEnv: "LOCALAI_BASE_URL",
    apiKeyEnvs: ["LOCALAI_API_KEY"],
    envHint: "LocalAI (127.0.0.1:8081)",
    local: true,
    curatedModels: [],
  },
]);

export const normalizeBaseUrl = (url: string): string =>
  url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(?:chat\/completions|completions|messages|models)$/i, "");

const hostLabelOf = (baseUrl: string): string => {
  try {
    const parsed = new URL(baseUrl);
    return parsed.host;
  } catch {
    return baseUrl.slice(0, 28);
  }
};

export const inferProtocolFromUrl = (
  baseUrl: string,
  explicit?: string | null,
): ProviderProtocol => {
  if (explicit === "anthropic-messages" || explicit === "openai-chat")
    return explicit;
  const lower = baseUrl.toLowerCase();
  if (lower.includes("api.anthropic.com")) return "anthropic-messages";
  return "openai-chat";
};

const isLoopbackUrl = (baseUrl: string): boolean => {
  try {
    const u = new URL(baseUrl);
    return (
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "::1"
    );
  } catch {
    return false;
  }
};

type RawModelEntry = string | { readonly id: string; readonly note?: string | undefined; readonly capabilities?: CapabilityMetadata | undefined };

const formatModelCapabilitiesNote = (
  raw: Record<string, unknown> | null,
): string | undefined => {
  if (!raw) return undefined;
  const parts: string[] = [];
  const ownedBy = asString(raw["owned_by"]).trim();
  if (ownedBy && ownedBy !== "system" && ownedBy !== "openai") {
    parts.push(ownedBy);
  }
  const caps = asRecord(raw["capabilities"]);
  const arch = asRecord(raw["architecture"]);
  const supportedParams = asArray(raw["supported_parameters"]).map((p) =>
    asString(p).toLowerCase(),
  );
  const inputModalities = asArray(arch?.["input_modalities"]).map((m) =>
    asString(m).toLowerCase(),
  );
  const rawCtx =
    raw["context_length"] ??
    raw["context_window"] ??
    raw["contextWindow"] ??
    raw["max_model_len"] ??
    caps?.["contextWindow"] ??
    caps?.["context_length"];
  const ctxNum = typeof rawCtx === "number" ? rawCtx : Number(rawCtx);
  if (Number.isFinite(ctxNum) && ctxNum >= 1024) {
    if (ctxNum >= 1_000_000) {
      parts.push(
        `${(ctxNum / 1_000_000).toFixed(ctxNum % 1_000_000 === 0 ? 0 : 1)}M ctx`,
      );
    } else {
      parts.push(`${Math.round(ctxNum / 1000)}k ctx`);
    }
  }
  if (
    caps?.["reasoning"] === true ||
    raw["reasoning"] === true ||
    raw["thinking"] === true ||
    supportedParams.includes("reasoning") ||
    supportedParams.includes("include_reasoning")
  ) {
    parts.push("think");
  }
  if (
    caps?.["vision"] === true ||
    raw["vision"] === true ||
    inputModalities.includes("image")
  ) {
    parts.push("vision");
  }
  if (
    caps?.["tools"] === true ||
    raw["tools"] === true ||
    raw["tool_call"] === true ||
    supportedParams.includes("tools")
  ) {
    parts.push("tools");
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
};

export const buildModelItems = (
  configuredIds: readonly string[],
  liveEntries: readonly RawModelEntry[],
  curatedIds: readonly string[],
): ProviderModelItem[] => {
  const byId = new Map<string, ProviderModelItem>();
  const order: string[] = [];
  const upsert = (
    entry: RawModelEntry,
    source: ProviderModelItem["source"],
  ): void => {
    const id = (typeof entry === "string" ? entry : entry.id).trim();
    const note = typeof entry === "string" ? undefined : entry.note;
    const capabilities = typeof entry === "string" ? undefined : entry.capabilities;
    if (!id) return;
    const existing = byId.get(id);
    if (existing) {
      if ((!existing.note && note) || capabilities) {
        byId.set(id, { ...existing, ...(!existing.note && note ? {note} : {}), ...(capabilities ? {capabilities} : {}) });
      }
      return;
    }
    order.push(id);
    byId.set(id, {
      id,
      label: id,
      source,
      ...(note ? { note } : {}),
      ...(capabilities ? {capabilities} : {}),
    });
  };
  for (const id of configuredIds) upsert(id, "configured");
  for (const entry of liveEntries) upsert(entry, "live");
  for (const id of curatedIds) upsert(id, "curated");
  return order.map((id) => byId.get(id)!);
};

const looksLikeInlineApiKey = (val: string): boolean => {
  const trimmed = val.trim();
  if (!trimmed) return false;
  if (/^(?:sk-|nr-|gsk_|xai-|AIza|eyJ|Bearer\s+)/i.test(trimmed)) return true;
  return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) && trimmed.length >= 12;
};

const routerProductOf = (value: unknown): RouterProduct | null =>
  value === "9router" || value === "omniroute" ? value : null;

const findNamedEntry = (entries: Record<string, unknown> | null, id: string): unknown => {
  if (!entries) return undefined;
  for (const [rawId, entry] of Object.entries(entries)) if (rawId.trim().toLowerCase() === id) return entry;
  return undefined;
};

/**
 * Pure synchronous provider discovery (< 0.3ms, zero network I/O, zero secret exposure).
 * Combines `omr-model.json` custom profiles, `OMR_*` overrides, and all 33 built-in providers.
 */
export const discoverProvidersSync = (
  env: NodeJS.ProcessEnv = process.env,
  storedConfig: Record<string, unknown> | null = null,
): ResolvedProvider[] => {
  const results: ResolvedProvider[] = [];
  const customBaseUrl = normalizeBaseUrl(
    env["OMR_BASE_URL"] ?? asString(storedConfig?.["base_url"]),
  );
  const customModel = (
    env["OMR_MODEL"] ?? asString(storedConfig?.["model"])
  ).trim();
  const customProviderId = asString(storedConfig?.["provider"])
    .trim()
    .toLowerCase();
  const customProtocol = inferProtocolFromUrl(
    customBaseUrl,
    env["OMR_PROTOCOL"] ?? asString(storedConfig?.["protocol"]),
  );
  const customApiKeyEnv = (
    env["OMR_API_KEY_ENV"] ?? asString(storedConfig?.["api_key_env"])
  ).trim();
  const customDirectKey = (
    env["OMR_API_KEY"] ??
    asString(storedConfig?.["api_key"]) ??
    (customApiKeyEnv && !env[customApiKeyEnv] && looksLikeInlineApiKey(customApiKeyEnv)
      ? customApiKeyEnv.replace(/^Bearer\s+/i, "")
      : "")
  ).trim();
  const customNamedKey = customApiKeyEnv ? env[customApiKeyEnv] : undefined;

  // Match configured baseUrl to a built-in provider when identical and no custom ID forced
  const matchedBuiltin = customBaseUrl
    ? BUILTIN_PROVIDERS.find((spec) => {
        if (customProviderId && customProviderId === spec.id) return true;
        const specUrl = normalizeBaseUrl(
          spec.resolveBaseUrl?.(env) ??
            (spec.baseUrlEnv
              ? (env[spec.baseUrlEnv] ?? spec.defaultBaseUrl)
              : spec.defaultBaseUrl),
        );
        return (
          specUrl.length > 0 &&
          specUrl.toLowerCase() === customBaseUrl.toLowerCase()
        );
      })
    : undefined;

  // Older versions copied a saved named provider's URL to the top level; that copy must not become a
  // second "custom" provider (its key would fall back to OPENAI_API_KEY).
  const namedProviderEntries = asRecord(storedConfig?.["providers"]);
  const namedDuplicate = Boolean(
    customBaseUrl &&
      customProviderId &&
      customProviderId !== "custom" &&
      sameEndpoint(
        customBaseUrl,
        asString(asRecord(findNamedEntry(namedProviderEntries, customProviderId))?.["base_url"]),
      ),
  );

  // 1. Dedicated custom endpoint from omr-model.json / OMR_BASE_URL (if not already a built-in)
  if (customBaseUrl && !matchedBuiltin && !namedDuplicate) {
    const localCustom = isLoopbackUrl(customBaseUrl);
    const resolvedKey =
      customDirectKey || customNamedKey || env["OPENAI_API_KEY"] || "";
    const keySource = customDirectKey
      ? env["OMR_API_KEY"]
        ? "env OMR_API_KEY"
        : "config api_key"
      : customNamedKey
        ? `env ${customApiKeyEnv}`
        : env["OPENAI_API_KEY"]
          ? "env OPENAI_API_KEY"
          : localCustom
            ? "local (no key)"
            : "missing";
    const configuredModels = [
      ...(customModel ? [customModel] : []),
      ...asArray(storedConfig?.["models"])
        .map((m) => asString(m))
        .filter(Boolean),
    ];
    results.push({
      id: "custom",
      name: `Custom (${hostLabelOf(customBaseUrl)})`,
      protocol: customProtocol,
      baseUrl: customBaseUrl,
      connected: Boolean(resolvedKey) || localCustom,
      local: localCustom,
      apiKey: resolvedKey,
      apiKeyEnv: customApiKeyEnv || "OMR_API_KEY",
      keySource,
      envHint: customApiKeyEnv || "OMR_API_KEY",
      headers: {},
      models: buildModelItems(configuredModels, [], []),
      liveLoaded: false,
      error: null,
      provenance: "config",
    });
  }

  // 2. Named extra custom providers in omr-model.json -> "providers": { "<id>": { base_url, api_key_env, ... } }
  const extraProviders = asRecord(storedConfig?.["providers"]);
  if (extraProviders) {
    for (const [rawId, rawEntry] of Object.entries(extraProviders)) {
      const id = rawId.trim().toLowerCase();
      if (!id || BUILTIN_PROVIDERS.some((b) => b.id === id) || id === "custom")
        continue;
      const entry = asRecord(rawEntry);
      if (!entry) continue;
      const bUrl = normalizeBaseUrl(asString(entry["base_url"]));
      if (!bUrl) continue;
      const kEnv = asString(entry["api_key_env"]).trim();
      const dKey = (
        asString(entry["api_key"]) ||
        (kEnv && !env[kEnv] && looksLikeInlineApiKey(kEnv)
          ? kEnv.replace(/^Bearer\s+/i, "")
          : "")
      ).trim();
      const nKey = kEnv ? env[kEnv] : undefined;
      const localEntry = isLoopbackUrl(bUrl);
      const apiKey = dKey || nKey || "";
      const modelsList = asArray(entry["models"])
        .map((m) => asString(m))
        .filter(Boolean);
      const defModel = asString(entry["model"]).trim();
      results.push({
        id,
        name: asString(entry["name"]).trim() || `Custom (${id})`,
        protocol: inferProtocolFromUrl(bUrl, asString(entry["protocol"])),
        baseUrl: bUrl,
        connected: Boolean(apiKey) || localEntry,
        local: localEntry,
        apiKey,
        apiKeyEnv: kEnv || "OMR_API_KEY",
        keySource: dKey
          ? "config api_key"
          : nKey
            ? `env ${kEnv}`
            : localEntry
              ? "local (no key)"
              : "missing",
        envHint: kEnv || "api_key_env in omr-model.json",
        headers: {},
        models: buildModelItems(
          defModel ? [defModel, ...modelsList] : modelsList,
          [],
          [],
        ),
        liveLoaded: false,
        error: null,
        provenance: "config-named",
        ...(routerProductOf(entry["router"]) ? { product: routerProductOf(entry["router"])! } : {}),
      });
    }
  }

  // 2b. Routers the user configured through OMR_9ROUTER_BASE_URL / OMR_OMNIROUTE_BASE_URL.
  for (const [product, spec] of Object.entries(ROUTER_PRODUCTS) as Array<[RouterProduct, (typeof ROUTER_PRODUCTS)[RouterProduct]]>) {
    const rawUrl = env[spec.baseUrlEnv]?.trim();
    if (!rawUrl || results.some((p) => p.id === product)) continue;
    const checked = validateCustomBaseUrl(rawUrl);
    if (!checked.ok) continue;
    const key = env[spec.apiKeyEnv]?.trim() ?? "";
    results.push({
      id: product,
      name: spec.name,
      protocol: "openai-chat",
      baseUrl: checked.value.baseUrl,
      connected: true,
      local: checked.value.loopback,
      apiKey: key,
      apiKeyEnv: spec.apiKeyEnv,
      keySource: key ? `env ${spec.apiKeyEnv}` : checked.value.loopback ? "local (no key)" : "missing",
      envHint: spec.apiKeyEnv,
      headers: {},
      models: [],
      liveLoaded: false,
      error: null,
      provenance: "env-router",
      product,
    });
  }

  // 3. Built-in providers (33 cloud, router, regional & local servers)
  for (const spec of BUILTIN_PROVIDERS) {
    const rawUrl =
      spec.resolveBaseUrl?.(env) ??
      (spec.baseUrlEnv && env[spec.baseUrlEnv]?.trim()
        ? env[spec.baseUrlEnv]!
        : spec.defaultBaseUrl);
    const baseUrl = normalizeBaseUrl(rawUrl ?? "");

    let foundEnv = "";
    let apiKey = "";
    for (const candidateEnv of spec.apiKeyEnvs) {
      const val = env[candidateEnv]?.trim();
      if (val) {
        foundEnv = candidateEnv;
        apiKey = val;
        break;
      }
    }

    // Inherit configured key/model if omr-model.json explicitly targets this built-in provider
    let keySource = foundEnv ? `env ${foundEnv}` : "missing";
    const configuredForThis: string[] = [];
    if (matchedBuiltin?.id === spec.id) {
      if (customModel) configuredForThis.push(customModel);
      if (!apiKey && (customDirectKey || customNamedKey)) {
        apiKey = customDirectKey || customNamedKey || "";
        keySource = customDirectKey
          ? env["OMR_API_KEY"]
            ? "env OMR_API_KEY"
            : "config api_key"
          : `env ${customApiKeyEnv}`;
      }
    }

    const explicitLocalEnv =
      spec.local === true &&
      Boolean(
        (spec.baseUrlEnv && env[spec.baseUrlEnv]?.trim()) ||
        (spec.id === "ollama" && env["OLLAMA_HOST"]?.trim()) ||
        matchedBuiltin?.id === spec.id,
      );
    const connected = Boolean(baseUrl) && (Boolean(apiKey) || explicitLocalEnv);
    if (spec.local && !apiKey) {
      keySource = "local (no key)";
    }

    results.push({
      id: spec.id,
      name: spec.name,
      protocol: spec.protocol,
      baseUrl,
      connected,
      local: spec.local === true,
      apiKey,
      apiKeyEnv:
        foundEnv ||
        (matchedBuiltin?.id === spec.id && customApiKeyEnv
          ? customApiKeyEnv
          : (spec.apiKeyEnvs[0] ?? "OMR_API_KEY")),
      keySource,
      envHint: spec.envHint,
      headers: spec.buildHeaders ? spec.buildHeaders(apiKey) : {},
      models: buildModelItems(configuredForThis, [], spec.curatedModels),
      liveLoaded: false,
      error: null,
      provenance: "builtin",
    });
  }

  return results;
};

const isChatCandidateModelId = (
  providerId: string,
  modelId: string,
): boolean => {
  const lower = modelId.toLowerCase();
  if (
    lower.includes("embedding") ||
    lower.includes("tts") ||
    lower.includes("whisper") ||
    lower.includes("dall-e") ||
    lower.includes("moderation") ||
    lower.includes("rerank") ||
    lower.includes("babbage") ||
    lower.includes("davinci-002")
  ) {
    return false;
  }
  if (providerId === "openai") {
    return /^(gpt-|o1|o3|o4|chatgpt-|codex)/i.test(modelId);
  }
  return true;
};

const candidateOpenAiModelUrls = (baseUrl: string): string[] => {
  const clean = normalizeBaseUrl(baseUrl);
  const urls: string[] = [`${clean}/models`];
  if (!/\/v\d+(?:beta)?$/i.test(clean)) {
    urls.push(`${clean}/v1/models`);
  } else {
    const root = clean.replace(/\/v\d+(?:beta)?$/i, "");
    if (root && root !== clean) {
      urls.push(`${root}/models`);
      urls.push(`${root}/api/v1/models`);
      urls.push(`${root}/api/tags`);
    }
  }
  return [...new Set(urls)];
};

const NON_CHAT_KINDS: ReadonlySet<string> = new Set([
  "embedding", "embeddings", "image", "images", "image-generation", "audio", "speech",
  "tts", "stt", "transcription", "rerank", "moderation", "video",
]);
// C0/C1/DEL controls and bidi controls must never reach the screen or a request.
// eslint-disable-next-line no-control-regex
const UNSAFE_MODEL_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_MODEL_TEXT_GLOBAL = new RegExp(UNSAFE_MODEL_TEXT.source, "g");
const CONTEXT_KEYS = ["context_length", "context_window", "contextWindow", "max_model_len"] as const;

/** B5 R2: accept an advertised limit only when it is plausible; otherwise drop both limits. */
const sanitizeAdvertisedLimits = (capabilities: CapabilityMetadata): { readonly capabilities: CapabilityMetadata; readonly dropped: boolean } => {
  const { contextWindow, maxOutputTokens } = capabilities;
  const plausibleWindow = contextWindow === undefined || (contextWindow >= 1024 && contextWindow <= 100_000_000);
  const plausibleOutput = typeof maxOutputTokens !== "number" || contextWindow === undefined || maxOutputTokens < contextWindow;
  if (plausibleWindow && plausibleOutput) return { capabilities, dropped: false };
  const { contextWindow: _window, maxOutputTokens: _output, ...rest } = capabilities;
  return { capabilities: rest, dropped: true };
};

export const extractLiveModelsFromPayload = (
  providerId: string,
  parsed: unknown,
  options: { readonly kindAware?: boolean } = {},
): RawModelEntry[] => {
  const rec = asRecord(parsed);
  const rawList = Array.isArray(parsed)
    ? parsed
    : asArray(
        rec?.["data"] ??
          rec?.["models"] ??
          asRecord(rec?.["result"])?.["models"] ??
          asRecord(rec?.["result"])?.["data"],
      );
  const kindAware = options.kindAware === true;
  const out: RawModelEntry[] = [];
  for (const item of rawList) {
    if (typeof item === "string") {
      if (kindAware && (item !== item.trim() || item.length > 256 || UNSAFE_MODEL_TEXT.test(item))) continue;
      const id = item.trim();
      if (id && isChatCandidateModelId(providerId, id)) {
        out.push(id);
      }
      continue;
    }
    const obj = asRecord(item);
    if (!obj) continue;
    const rawId = asString(obj["id"] ?? obj["name"] ?? obj["model"]);
    const id =
      providerId === "gemini" ? rawId.trim().replace(/^models\//, "") : kindAware ? rawId : rawId.trim();
    if (!id) continue;
    if (kindAware) {
      if (id !== id.trim() || id.length > 256 || UNSAFE_MODEL_TEXT.test(id)) continue;
      const kind = asString(obj["kind"] ?? obj["type"]).trim().toLowerCase();
      if (kind ? NON_CHAT_KINDS.has(kind) : !isChatCandidateModelId(providerId, id)) continue;
    } else if (!isChatCandidateModelId(providerId, id)) {
      continue;
    }
    let source: Record<string, unknown> = obj;
    let capabilities = parseCapabilityMetadata(obj);
    if (kindAware) {
      const checked = sanitizeAdvertisedLimits(capabilities);
      capabilities = checked.capabilities;
      if (checked.dropped) {
        const stripped: Record<string, unknown> = { ...obj };
        for (const key of CONTEXT_KEYS) delete stripped[key];
        const caps = asRecord(stripped["capabilities"]);
        if (caps) stripped["capabilities"] = { ...caps, contextWindow: undefined, context_length: undefined };
        source = stripped;
      }
    }
    let note = formatModelCapabilitiesNote(source);
    if (kindAware && note) note = note.replace(UNSAFE_MODEL_TEXT_GLOBAL, "");
    out.push(note || Object.keys(capabilities).length ? {id, ...(note ? {note} : {}), ...(Object.keys(capabilities).length ? {capabilities} : {})} : id);
  }
  return out;
};

/**
 * Fetch live models for a single provider (with bounded timeout & retry; never throws).
 * Also auto-marks reachable local servers (Ollama / LM Studio / vLLM / llama.cpp / LocalAI) as connected!
 */
export const fetchProviderModels = async (
  provider: ResolvedProvider,
  signal?: AbortSignal,
): Promise<ResolvedProvider> => {
  if (!provider.baseUrl) return provider;
  if (!provider.connected && !provider.local) return provider;

  const timeoutMs = provider.local ? 1_200 : 12_000;
  const makeSignal = (): AbortSignal => {
    const t = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, t]) : t;
  };

  const configuredIds = provider.models
    .filter((m) => m.source === "configured")
    .map((m) => m.id);
  const curatedIds = provider.models
    .filter((m) => m.source === "curated")
    .map((m) => m.id);

  try {
    // 1. Anthropic native /v1/models
    if (provider.protocol === "anthropic-messages") {
      const urls = [`${provider.baseUrl}/models?limit=100`];
      if (!provider.baseUrl.endsWith("/v1")) {
        urls.push(`${provider.baseUrl}/v1/models?limit=100`);
      }
      let lastStatus = 0;
      for (const url of urls) {
        const response = await fetch(url, {
          headers: {
            ...(provider.apiKey
              ? {
                  "x-api-key": provider.apiKey,
                  authorization: `Bearer ${provider.apiKey}`,
                }
              : {}),
            "anthropic-version": "2023-06-01",
            accept: "application/json",
            ...provider.headers,
          },
          signal: makeSignal(),
        });
        lastStatus = response.status;
        if (!response.ok) continue;
        const parsed: unknown = await response.json();
        const liveEntries = extractLiveModelsFromPayload(provider.id, parsed);
        return {
          ...provider,
          connected: true,
          models: buildModelItems(configuredIds, liveEntries, curatedIds),
          liveLoaded: true,
          error: null,
        };
      }
      return {
        ...provider,
        liveLoaded: false,
        error: `HTTP ${lastStatus}`,
      };
    }

    // 2. Google Gemini native v1beta/models listing
    if (
      provider.id === "gemini" &&
      provider.baseUrl.includes("generativelanguage.googleapis.com")
    ) {
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100",
        {
          headers: {
            "x-goog-api-key": provider.apiKey,
            accept: "application/json",
          },
          signal: makeSignal(),
        },
      );
      if (!response.ok) {
        return {
          ...provider,
          liveLoaded: false,
          error: `HTTP ${response.status}`,
        };
      }
      const parsed: unknown = await response.json();
      const liveIds = asArray(asRecord(parsed)?.["models"])
        .filter((item) => {
          const methods = asArray(
            asRecord(item)?.["supportedGenerationMethods"],
          ).map((m) => asString(m));
          return methods.length === 0 || methods.includes("generateContent");
        })
        .map((item) =>
          asString(asRecord(item)?.["name"]).replace(/^models\//, ""),
        )
        .filter((id) => Boolean(id) && isChatCandidateModelId("gemini", id));
      return {
        ...provider,
        connected: true,
        models: buildModelItems(configuredIds, liveIds, curatedIds),
        liveLoaded: true,
        error: null,
      };
    }

    // 3. Ollama native /api/tags (faster & richer than /v1/models on local daemon)
    if (provider.id === "ollama") {
      const origin = provider.baseUrl.replace(/\/v1$/i, "");
      const response = await fetch(`${origin}/api/tags`, {
        headers: { accept: "application/json" },
        signal: makeSignal(),
      });
      if (response.ok) {
        const parsed: unknown = await response.json();
        const liveEntries = extractLiveModelsFromPayload("ollama", parsed);
        return {
          ...provider,
          connected: true,
          models: buildModelItems(
            configuredIds,
            liveEntries,
            liveEntries.length > 0 ? [] : curatedIds,
          ),
          liveLoaded: true,
          error: null,
        };
      }
    }

    // 4. OpenAI-compatible GET <baseUrl>/models (with fallback URL probing & 1 retry on transient error)
    const headers: Record<string, string> = {
      accept: "application/json",
      ...provider.headers,
    };
    if (provider.apiKey) {
      headers["authorization"] = `Bearer ${provider.apiKey}`;
      if (!headers["x-api-key"]) {
        headers["x-api-key"] = provider.apiKey;
      }
    }

    const urls = candidateOpenAiModelUrls(provider.baseUrl);
    let lastHttpError: string | null = null;
    const maxAttempts = provider.local ? 1 : 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      for (const url of urls) {
        try {
          const response = await fetch(url, {
            headers,
            signal: makeSignal(),
          });
          if (!response.ok) {
            lastHttpError = `HTTP ${response.status}`;
            if (response.status === 404 || response.status >= 500) {
              continue;
            }
            break;
          }
          const parsed: unknown = await response.json();
          const liveEntries = extractLiveModelsFromPayload(provider.id, parsed);
          if (liveEntries.length > 0 || url === urls[0]) {
            return {
              ...provider,
              connected: true,
              models: buildModelItems(
                configuredIds,
                liveEntries,
                provider.local && liveEntries.length > 0 ? [] : curatedIds,
              ),
              liveLoaded: true,
              error: null,
            };
          }
        } catch (err) {
          lastHttpError =
            err instanceof Error ? err.message.slice(0, 60) : "fetch failed";
        }
      }
    }

    return {
      ...provider,
      liveLoaded: false,
      error: provider.local ? null : lastHttpError,
    };
  } catch (err) {
    return {
      ...provider,
      liveLoaded: false,
      error: provider.local
        ? null
        : err instanceof Error
          ? err.message.slice(0, 60)
          : "fetch failed",
    };
  }
};

/**
 * Refresh live model lists across all connected providers + local loopback servers in parallel.
 */
export const refreshAllProviders = async (
  providers: readonly ResolvedProvider[],
  signal?: AbortSignal,
): Promise<ResolvedProvider[]> =>
  Promise.all(
    providers.map((provider) =>
      provider.connected || provider.local
        ? fetchProviderModels(provider, signal)
        : Promise.resolve(provider),
    ),
  );
