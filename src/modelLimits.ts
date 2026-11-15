/**
 * Authoritative context-window / output-limit discovery. Nothing here guesses:
 * a limit is used only if the serving endpoint reports it, or if the maintained
 * models.dev database lists the exact provider + model identity. Anything else
 * stays unknown and the caller says so.
 *
 * Resolution order (first hit wins, later sources only fill missing fields):
 *   1. fresh on-disk cache of a previous successful lookup (24h)
 *   2. live metadata from the endpoint's own model listing
 *   3. models.dev (https://models.dev/api.json), exact provider/model match
 *
 * Only public identifiers (provider id, base URL, model id) touch the cache; API keys
 * and prompts are never written or sent. models.dev is fetched without any identifying data.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CapabilityMetadata } from "./capabilities.js";
import { asRecord } from "./values.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const LIVE_TTL_MS = 24 * 60 * 60 * 1000;
const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INDEX_TIMEOUT_MS = 8_000;

/**
 * omr provider id → models.dev provider id. Providers absent here have no models.dev entry
 * (or serve a locally loaded context that differs from the model maximum) and are never guessed.
 */
const MODELS_DEV_PROVIDER: Readonly<Record<string, string>> = {
  openai: "openai", anthropic: "anthropic", gemini: "google", openrouter: "openrouter",
  deepseek: "deepseek", xai: "xai", groq: "groq", mistral: "mistral", cerebras: "cerebras",
  sambanova: "sambanova", together: "togetherai", fireworks: "fireworks-ai", deepinfra: "deepinfra",
  siliconflow: "siliconflow", nvidia: "nvidia", qwen: "alibaba", moonshot: "moonshotai",
  zhipu: "zhipuai", minimax: "minimax", cohere: "cohere", perplexity: "perplexity",
  huggingface: "huggingface", novita: "novita-ai", chutes: "chutes", azure: "azure",
  cloudflare: "cloudflare-workers-ai",
};

/** `provider → model → [context, output | null]` */
export type ModelsDevIndex = Readonly<Record<string, Readonly<Record<string, readonly [number, number | null]>>>>;

const configDir = (env: NodeJS.ProcessEnv): string => join(env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "rea");

const positiveInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

/** Reduce the ~6 MB models.dev document to the two numbers omr needs. */
export const slimModelsDev = (raw: unknown): ModelsDevIndex => {
  const out: Record<string, Record<string, readonly [number, number | null]>> = {};
  for (const [providerId, provider] of Object.entries(asRecord(raw) ?? {})) {
    const models = asRecord(asRecord(provider)?.["models"]);
    if (!models) continue;
    const slim: Record<string, readonly [number, number | null]> = {};
    for (const [modelId, model] of Object.entries(models)) {
      const limit = asRecord(asRecord(model)?.["limit"]);
      const context = positiveInt(limit?.["context"]);
      if (context) slim[modelId] = [context, positiveInt(limit?.["output"])];
    }
    if (Object.keys(slim).length) out[providerId] = slim;
  }
  return out;
};

/** Exact provider + model identity only; a gateway alias does not prove it serves the upstream model. */
export const lookupModelsDev = (index: ModelsDevIndex, providerId: string, model: string): CapabilityMetadata | null => {
  const mapped = MODELS_DEV_PROVIDER[providerId];
  const hit = mapped ? index[mapped]?.[model] : undefined;
  return hit ? { contextWindow: hit[0], ...(hit[1] ? { maxOutputTokens: hit[1] } : {}) } : null;
};

// ── disk cache ────────────────────────────────────────────────────────────────

interface LiveEntry { contextWindow?: number; maxOutputTokens?: number; origin: "provider" | "models.dev"; fetchedAt: number }
interface LiveFile { version: 1; entries: Record<string, LiveEntry> }
interface IndexFile { version: 1; fetchedAt: number; index: ModelsDevIndex }

const readJson = <T>(path: string): T | null => {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
};

const writeJson = (path: string, value: unknown): void => {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // Caches are an optimization; a read-only config dir must never break a session.
  }
};

export const limitsCacheKey = (providerId: string, baseUrl: string, model: string): string => `${providerId}|${baseUrl}|${model}`;

export interface LimitSources {
  readonly env: NodeJS.ProcessEnv;
  /** Metadata the serving endpoint itself reports for this model, if any. */
  readonly live: () => Promise<CapabilityMetadata | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

export interface ResolvedLimits {
  readonly metadata: CapabilityMetadata;
  readonly origin: "cache" | "provider" | "models.dev";
}

const loadIndex = async (sources: LimitSources): Promise<ModelsDevIndex | null> => {
  const now = (sources.now ?? Date.now)();
  const path = join(configDir(sources.env), "omr-modelsdev.json");
  const cached = readJson<IndexFile>(path);
  if (cached?.version === 1 && now - cached.fetchedAt < INDEX_TTL_MS) return cached.index;
  try {
    const timeout = AbortSignal.timeout(INDEX_TIMEOUT_MS);
    const response = await (sources.fetchImpl ?? fetch)(MODELS_DEV_URL, {
      signal: sources.signal ? AbortSignal.any([sources.signal, timeout]) : timeout,
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`models.dev ${response.status}`);
    const index = slimModelsDev(await response.json());
    if (Object.keys(index).length) {
      writeJson(path, { version: 1, fetchedAt: now, index } satisfies IndexFile);
      return index;
    }
  } catch {
    // Offline or blocked: a stale index is still real data, unlike a guess.
  }
  return cached?.version === 1 ? cached.index : null;
};

/**
 * Resolve the context window (and output limit) of one model without assuming anything.
 * Returns null when no source knows the model.
 */
export const resolveLimits = async (
  providerId: string,
  baseUrl: string,
  model: string,
  sources: LimitSources,
): Promise<ResolvedLimits | null> => {
  const now = (sources.now ?? Date.now)();
  const cachePath = join(configDir(sources.env), "omr-limits.json");
  const file = readJson<LiveFile>(cachePath);
  const key = limitsCacheKey(providerId, baseUrl, model);
  const cached = file?.version === 1 ? file.entries[key] : undefined;
  if (cached && now - cached.fetchedAt < LIVE_TTL_MS && cached.contextWindow) {
    return { metadata: { contextWindow: cached.contextWindow, ...(cached.maxOutputTokens ? { maxOutputTokens: cached.maxOutputTokens } : {}) }, origin: "cache" };
  }

  let metadata: CapabilityMetadata = {};
  let origin: "provider" | "models.dev" = "provider";
  try {
    metadata = (await sources.live()) ?? {};
  } catch {
    metadata = {};
  }
  if (!metadata.contextWindow && MODELS_DEV_PROVIDER[providerId]) {
    const index = await loadIndex(sources);
    const fallback = index ? lookupModelsDev(index, providerId, model) : null;
    if (fallback) {
      metadata = { ...fallback, ...metadata, ...(fallback.contextWindow ? { contextWindow: fallback.contextWindow } : {}) };
      origin = "models.dev";
    }
  }
  if (!metadata.contextWindow) return null;

  const entries = { ...(file?.version === 1 ? file.entries : {}) };
  entries[key] = {
    contextWindow: metadata.contextWindow,
    ...(metadata.maxOutputTokens ? { maxOutputTokens: metadata.maxOutputTokens } : {}),
    origin,
    fetchedAt: now,
  };
  writeJson(cachePath, { version: 1, entries } satisfies LiveFile);
  return { metadata, origin };
};
