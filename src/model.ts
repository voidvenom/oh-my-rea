import { resolveModelCapabilities, estimateRequestTokens, ContextOverflowError, type ModelCapabilities } from "./capabilities.js";
import { lookup } from "node:dns/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { createConnection, isIP } from "node:net";
import { asArray, asNumber, asRecord, asString } from "./values.js";
import { REASONING_EFFORT_LEVELS, type ModelConfig } from "./modelConfig.js";
import { describeAttachedImagesFallback } from "./vision.js";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Anthropic extended-thinking block that must be replayed verbatim (with signature) inside tool loops. */
export type ThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface ChatImageBlock {
  readonly mimeType: string;
  /** Base64-encoded image payload (without `data:` prefix). */
  readonly data: string;
  readonly detail?: "auto" | "low" | "high" | "original";
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Optional inline images (e.g. snapcompact bitmap archive frames on a user summary message). */
  images?: readonly ChatImageBlock[];
  /** Estimated billed vision tokens for attached images, used by context window accounting. */
  image_tokens?: number;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  /**
   * OpenAI-compatible `reasoning_content` streamed by thinking models (DeepSeek, Kimi, Qwen, GLM…).
   * Echoed back only for assistant tool-call messages inside the active turn, where those APIs require it.
   */
  reasoning_content?: string;
  /** Signed Anthropic thinking blocks replayed before `tool_use` while extended thinking is enabled. */
  thinking_blocks?: ThinkingBlock[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  /** Prompt tokens served from the provider prompt cache (a subset of `prompt_tokens`). */
  cached_tokens?: number | null;
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  usage: Usage | null;
  /** `reasoning_content` text to echo back during the active tool loop, or null when not field-based. */
  reasoningContent: string | null;
  /** Signed Anthropic thinking blocks to replay before `tool_use`. */
  thinkingBlocks: ThinkingBlock[];
}

export interface RetryNotice {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly delayMs: number;
  readonly reason: string;
}

export interface NetworkProbeResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly reason?: string;
  /** Non-null (`host:port`) when the probe routed through `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`. */
  readonly viaProxy?: string | null;
}

export interface FailoverNotice {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly candidateIndex: number;
  readonly totalCandidates: number;
}

export interface NetworkStatusNotice {
  readonly state: "offline" | "pinging" | "restored";
  readonly target: string;
  readonly attempt: number;
  readonly reason: string;
  readonly offlineDurationMs: number;
  readonly nextPingInMs: number | null;
  readonly latencyMs: number | null;
}

export interface ModelPort {
  readonly model: string;
  readonly providerId?: string;
  readonly providerName?: string;
  readonly endpoint?: string;
  readonly capabilities?: ModelCapabilities;
  readonly outputReserveTokens?: number;
  readonly attemptAccounting?: boolean;
  readonly sessionUsage?: SessionUsageView;
  stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal | undefined,
    onText: (delta: string) => void,
    onReasoning?: (delta: string) => void,
    onRetry?: (notice: RetryNotice) => void,
    onNetworkStatus?: (notice: NetworkStatusNotice) => void,
    onStreamReset?: () => void,
    limits?: ModelRequestLimits,
  ): Promise<StreamResult>;
  summarize(
    system: string,
    user: string,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string>;
  summarizeDetailed?(system: string, user: string, maxTokens: number, signal?: AbortSignal, limits?: ModelRequestLimits): Promise<SummaryResult>;
  compactRemote?(
    system: string,
    user: string,
    maxTokens: number,
    signal?: AbortSignal,
    customEndpoint?: string | null,
  ): Promise<string>;
  compactRemoteDetailed?(system: string, user: string, maxTokens: number, signal?: AbortSignal, endpoint?: string | null, limits?: ModelRequestLimits): Promise<SummaryResult>;
}

export interface SessionUsageView {
  readonly totalTokens: number;
  readonly scopeTokens: number;
  readonly budgetTokens: number | null;
  readonly reservedTokens: number;
  readonly estimatedTokens: number;
}
export interface SummaryResult {readonly summary: string; readonly usage: Usage | null;}
export interface ModelAttemptAccounting {
  beforeAttempt(model: string, contextWindow: number, requestedOutput: number): Promise<number>;
  completed(usage: Usage | null): Promise<void>;
  failed(error: unknown): Promise<void>;
}
export interface ModelRequestLimits {readonly maxOutputTokens?: number; readonly accounting?: ModelAttemptAccounting;}

export class ModelCapabilityError extends Error {readonly unbilled = true;}

interface AccumulatedCall {
  id: string;
  name: string;
  arguments: string;
}

/** Model HTTP or stream failure with an explicit retry classification. */
export class ModelRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "ModelRequestError";
  }
}

/** Raised when a model stream delivers no bytes for the configured idle window. */
export class ModelStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelStallError";
  }
}

const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_PING_INTERVAL_MS = 1_500;
const DEFAULT_MAX_NETWORK_WAIT_MS = 15 * 60 * 1_000;
const RETRYABLE_STATUS = new Set([
  408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529,
]);
const NON_RETRYABLE_DETAIL =
  /insufficient_quota|exceeded your current quota|billing|credit balance|invalid[_ ]api[_ ]key|authentication|permission/i;
const RETRYABLE_STREAM_ERROR =
  /overload|rate[_ ]?limit|timeout|timed out|unavailable|server[_ ]error|internal|capacity|busy|api_error/i;
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EAI_NODATA",
  "EAI_NONAME",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ERR_SOCKET_CLOSED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const extractErrorCode = (error: unknown): string => {
  let cur: unknown = error;
  for (let depth = 0; depth < 4 && cur; depth += 1) {
    const rec = asRecord(cur);
    const code = asString(rec?.["code"]);
    if (code) return code;
    cur = rec?.["cause"];
  }
  return "";
};

export const formatPingTarget = (baseUrl: string): string => {
  try {
    const url = new URL(baseUrl);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${url.hostname}:${port}`;
  } catch {
    return baseUrl.replace(/^https?:\/\//i, "").split("/")[0] || "endpoint";
  }
};

const isNoProxyHost = (hostname: string, noProxyRaw: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  if (!noProxyRaw.trim()) return false;
  for (const rawEntry of noProxyRaw.split(",")) {
    const entry = rawEntry.trim().toLowerCase().split(":")[0] ?? "";
    if (!entry) continue;
    if (entry === "*") return true;
    const stripped = entry.startsWith(".") ? entry.slice(1) : entry;
    if (host === stripped || host.endsWith(`.${stripped}`)) return true;
  }
  return false;
};

/**
 * Resolve active proxy target (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`) for `baseUrl`
 * while honoring `NO_PROXY` / loopback exemptions.
 */
export const resolveProxyForEndpoint = (
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): { proxyUrl: string; host: string; port: number } | null => {
  try {
    const target = new URL(baseUrl);
    const noProxy = env["NO_PROXY"] ?? env["no_proxy"] ?? "";
    if (isNoProxyHost(target.hostname, noProxy)) return null;
    const isHttps = target.protocol === "https:";
    const rawProxy = (
      (isHttps
        ? env["HTTPS_PROXY"] ?? env["https_proxy"]
        : env["HTTP_PROXY"] ?? env["http_proxy"]) ??
      env["ALL_PROXY"] ??
      env["all_proxy"] ??
      env["HTTPS_PROXY"] ??
      env["https_proxy"] ??
      env["HTTP_PROXY"] ??
      env["http_proxy"] ??
      ""
    ).trim();
    if (!rawProxy) return null;
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawProxy)
      ? rawProxy
      : `http://${rawProxy}`;
    const proxyUrl = new URL(normalized);
    const host = proxyUrl.hostname.replace(/^\[|\]$/g, "");
    if (!host) return null;
    const port = proxyUrl.port
      ? Number(proxyUrl.port)
      : proxyUrl.protocol.startsWith("socks")
        ? 1080
        : proxyUrl.protocol === "https:"
          ? 443
          : 8080;
    return { proxyUrl: rawProxy, host, port };
  } catch {
    return null;
  }
};

/**
 * Lightweight DNS + TCP handshake probe to the configured LLM endpoint origin (or active proxy).
 * Never sends HTTP requests or consumes provider rate limits; verifies interface,
 * DNS resolution, and TCP reachability while measuring round-trip latency in ms.
 */
export const probeEndpointConnectivity = async (
  baseUrl: string,
  signalOrTimeout?: AbortSignal | number,
  timeoutMsArg = 3_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NetworkProbeResult> => {
  const signal =
    typeof signalOrTimeout === "object" && signalOrTimeout !== null
      ? signalOrTimeout
      : undefined;
  const timeoutMs =
    typeof signalOrTimeout === "number" ? signalOrTimeout : timeoutMsArg;
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const t0 = performance.now();
  let hostname = "127.0.0.1";
  let port = 443;
  try {
    const url = new URL(baseUrl);
    hostname = url.hostname.replace(/^\[|\]$/g, "");
    port = url.port
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : 80;
  } catch {
    return { ok: false, latencyMs: 0, reason: "INVALID_URL", viaProxy: null };
  }

  const proxy = resolveProxyForEndpoint(baseUrl, env);
  const viaProxy = proxy ? `${proxy.host}:${proxy.port}` : null;
  if (proxy) {
    hostname = proxy.host;
    port = proxy.port;
  }

  let address = hostname;
  if (isIP(hostname) === 0 && hostname.toLowerCase() !== "localhost") {
    try {
      const resolved = await lookup(hostname);
      address = resolved.address;
    } catch (dnsErr) {
      const code = extractErrorCode(dnsErr) || "DNS_FAIL";
      return {
        ok: false,
        latencyMs: Math.max(1, Math.round(performance.now() - t0)),
        reason: code,
        viaProxy,
      };
    }
  }
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  return new Promise<NetworkProbeResult>((resolve, reject) => {
    let settled = false;
    const socket = createConnection({ host: address, port });
    const finish = (res: NetworkProbeResult): void => {
      if (settled) return;
      settled = true;
      if (typeof signal?.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
      socket.removeAllListeners();
      socket.destroy();
      resolve(res);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    socket.setTimeout(Math.max(200, timeoutMs));
    socket.once("connect", () => {
      finish({
        ok: true,
        latencyMs: Math.max(1, Math.round(performance.now() - t0)),
        reason: "ok",
        viaProxy,
      });
    });
    socket.once("timeout", () => {
      finish({
        ok: false,
        latencyMs: Math.max(1, Math.round(performance.now() - t0)),
        reason: "ETIMEDOUT",
        viaProxy,
      });
    });
    socket.once("error", (err) => {
      const code = extractErrorCode(err) || err.message || "SOCKET_ERR";
      finish({
        ok: false,
        latencyMs: Math.max(1, Math.round(performance.now() - t0)),
        reason: code,
        viaProxy,
      });
    });
    if (typeof signal?.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
};

const parseRetryAfter = (headers: Headers): number | null => {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(ms))
    return Math.max(0, ms);
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
};

const httpError = async (
  label: string,
  response: Response,
): Promise<ModelRequestError> => {
  const detail = (await response.text().catch(() => "")).slice(0, 1200);
  const retryable =
    RETRYABLE_STATUS.has(response.status) && !NON_RETRYABLE_DETAIL.test(detail);
  return new ModelRequestError(
    `${label} HTTP ${response.status}: ${detail || response.statusText}`,
    response.status,
    retryable,
    parseRetryAfter(response.headers),
  );
};

const streamError = (label: string, value: unknown): ModelRequestError => {
  const record = asRecord(value);
  const message =
    asString(record?.["message"]) ||
    (typeof value === "string" ? value : JSON.stringify(value));
  const kind = `${asString(record?.["type"])} ${String(record?.["code"] ?? "")} ${message}`;
  const retryable =
    RETRYABLE_STREAM_ERROR.test(kind) && !NON_RETRYABLE_DETAIL.test(kind);
  return new ModelRequestError(
    `${label} stream error: ${message}`,
    asNumber(record?.["status"]),
    retryable,
    null,
  );
};

export const isNetworkOutageError = (error: unknown): boolean => {
  if (error instanceof ModelStallError) return false;
  if (error instanceof ModelRequestError) {
    return error.status === null && error.retryable;
  }
  const code = extractErrorCode(error);
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return false;
    }
    return /fetch failed|terminated|network error|socket hang up|other side closed|getaddrinfo|connect E|read ECONNRESET|write EPIPE|ECONNREFUSED|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ETIMEDOUT/i.test(
      error.message,
    );
  }
  return false;
};

export const networkOutageReason = (error: unknown): string => {
  const code = extractErrorCode(error);
  if (code) return code;
  if (error instanceof ModelRequestError) {
    if (/ended before|interrupted/i.test(error.message)) {
      return "STREAM_DROPPED";
    }
    return error.status !== null
      ? `HTTP_${error.status}`
      : error.message.slice(0, 32);
  }
  if (error instanceof Error) {
    if (error.message === "fetch failed") return "FETCH_FAILED";
    if (error.message === "terminated") return "STREAM_TERMINATED";
    return error.message.slice(0, 32);
  }
  return "NET_DROP";
};

export const isRetryableModelError = (error: unknown): boolean => {
  if (isNetworkOutageError(error)) return true;
  if (error instanceof ModelRequestError) return error.retryable;
  return false;
};

const retryDelayMs = (attempt: number, error: unknown): number => {
  const hinted = error instanceof ModelRequestError ? error.retryAfterMs : null;
  if (hinted !== null) return Math.min(MAX_RETRY_DELAY_MS, hinted);
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return Math.round(base * (0.75 + Math.random() * 0.5));
};

const retryReason = (error: unknown): string => {
  if (error instanceof ModelRequestError) {
    return error.status !== null
      ? `HTTP ${error.status}`
      : error.message.slice(0, 60);
  }
  return error instanceof Error
    ? error.message.slice(0, 60)
    : String(error).slice(0, 60);
};

const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

interface Watchdog {
  readonly signal: AbortSignal;
  touch(): void;
  dispose(): void;
}

/**
 * Inactivity watchdog: aborts only when no bytes arrive for `idleMs`, so long
 * high-effort reasoning streams are never cut off while they keep producing data.
 */
const createWatchdog = (idleMs: number, parent?: AbortSignal): Watchdog => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  const fire = (): void => {
    controller.abort(
      new ModelStallError(
        `model stream stalled: no data received for ${Math.round(idleMs / 1000)}s (raise OMR_TIMEOUT_MS for slow models)`,
      ),
    );
  };
  const touch = (): void => {
    if (controller.signal.aborted) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, idleMs);
    timer.unref?.();
  };
  const onParentAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  touch();
  return {
    signal: controller.signal,
    touch,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
};

/** Read a Server-Sent Events body line by line, feeding each `data:` payload to `onData`. */
const readSse = async (
  body: ReadableStream<Uint8Array>,
  watchdog: Watchdog,
  onData: (data: string) => void,
): Promise<void> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flushLine = (raw: string): void => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("data:")) onData(line.slice(5).trim());
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      watchdog.touch();
      buffer += decoder.decode(value, { stream: true });
      let start = 0;
      let newline = buffer.indexOf("\n", start);
      while (newline >= 0) {
        flushLine(buffer.slice(start, newline));
        start = newline + 1;
        newline = buffer.indexOf("\n", start);
      }
      buffer = start > 0 ? buffer.slice(start) : buffer;
    }
    buffer += decoder.decode();
    for (const tail of buffer.split("\n")) flushLine(tail);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
};

/** Normalize OpenAI, OpenAI-compatible (DeepSeek, Kimi…) and Anthropic usage records, including cache hits. */
const usageOf = (value: unknown): Usage | null => {
  const record = asRecord(value);
  if (!record) return null;
  const cacheRead = asNumber(record["cache_read_input_tokens"]);
  const cacheWrite = asNumber(record["cache_creation_input_tokens"]);
  let prompt = asNumber(record["prompt_tokens"]);
  if (prompt === null) {
    const input = asNumber(record["input_tokens"]);
    if (input !== null || cacheRead !== null || cacheWrite !== null) {
      prompt = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
    }
  }
  const completion =
    asNumber(record["completion_tokens"]) ?? asNumber(record["output_tokens"]);
  const total = asNumber(record["total_tokens"]);
  if (prompt === null && completion === null && total === null) return null;
  const cached =
    asNumber(asRecord(record["prompt_tokens_details"])?.["cached_tokens"]) ??
    asNumber(record["prompt_cache_hit_tokens"]) ??
    cacheRead;
  const usage: Usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens:
      total ??
      (prompt !== null && completion !== null ? prompt + completion : null),
  };
  if (cached !== null) usage.cached_tokens = cached;
  return usage;
};

const callsFromMessage = (message: unknown): ChatToolCall[] => {
  const record = asRecord(message);
  const calls = asArray(record?.["tool_calls"]);
  const parsed: ChatToolCall[] = [];
  calls.forEach((value, index) => {
    const call = asRecord(value);
    const fn = asRecord(call?.["function"]);
    if (!fn) return;
    const name = asString(fn["name"]);
    if (!name) return;
    parsed.push({
      id: asString(call?.["id"]) || `call_${index}`,
      type: "function",
      function: {
        name,
        arguments: asString(fn["arguments"], "{}"),
      },
    });
  });
  return parsed;
};

const reasoningTextOf = (record: Record<string, unknown> | null): string => {
  if (!record) return "";
  if (typeof record["reasoning_content"] === "string")
    return record["reasoning_content"];
  if (typeof record["reasoning"] === "string") return record["reasoning"];
  const details = asArray(record["reasoning_details"]);
  if (details.length > 0) {
    return details
      .map((item) => asString(asRecord(item)?.["text"]))
      .filter(Boolean)
      .join("");
  }
  return "";
};

const usesOpenAiCompletionTokens = (
  baseUrl: string,
  model: string,
): boolean => {
  if (!baseUrl.toLowerCase().includes("api.openai.com")) return false;
  return /^(o1|o3|o4|gpt-5)/i.test(model.trim());
};

const safeParseJsonObject = (raw: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
};

/** Anthropic rejects empty or whitespace-only text blocks. */
const nonBlankText = (
  text: string | null | undefined,
  fallback: string,
): string => (text && text.trim().length > 0 ? text : fallback);

const EPHEMERAL_CACHE = Object.freeze({ type: "ephemeral" });

/**
 * Anthropic reasoning dialects: `budget` (`thinking.type = "enabled"` + `budget_tokens`, older
 * models) and `adaptive` (`thinking.type = "adaptive"` + `output_config.effort`, current models
 * that reject `budget_tokens` with HTTP 400).
 */
export type AnthropicThinkingStyle = "budget" | "adaptive";

/** Pick the dialect from the model id; the client self-corrects through compatibility memory on a 400. */
export const anthropicThinkingStyle = (
  model: string,
): AnthropicThinkingStyle => {
  const id = model.toLowerCase();
  const match =
    /claude-(?:opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2}))?(?!\d)/.exec(id) ??
    /claude-(\d+)(?:[-.](\d{1,2}))?-(?:opus|sonnet|haiku)/.exec(id);
  if (!match) return "budget";
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return major >= 5 || (major === 4 && minor >= 7) ? "adaptive" : "budget";
};

/** Hard output ceiling by model family; Opus 4/4.1 stop at 32k, current models allow 64k. */
const anthropicOutputCap = (model: string): number =>
  /claude-opus-4(?:[-.]1)?(?!\d)/i.test(model) || /claude-3/i.test(model)
    ? 32_000
    : 64_000;

const ADAPTIVE_OUTPUT_FLOOR: Readonly<Record<string, number>> = {
  minimal: 8_192,
  low: 8_192,
  medium: 16_384,
  high: 32_768,
  xhigh: 49_152,
};

export interface AnthropicPayloadOptions {
  readonly style?: AnthropicThinkingStyle;
  /** Send no reasoning parameters at all (used after an endpoint rejected every dialect). */
  readonly disableReasoning?: boolean;
  /** Convert inline image blocks into a rich forensic text description when the endpoint rejects vision. */
  readonly disableImages?: boolean;
}

/**
 * Convert OpenAI-shaped `ChatMessage[]` into an Anthropic `/v1/messages` payload
 * (cached `system` block + strictly alternating `user`/`assistant` content blocks).
 * Prompt-cache breakpoints mark the tool list, the system prompt, and the newest
 * block so every agent step re-reads the previous step's prefix from cache.
 */
export const buildAnthropicPayload = (
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[],
  config: ModelConfig,
  options: AnthropicPayloadOptions = {},
): Record<string, unknown> => {
  const effort = options.disableReasoning
    ? "auto"
    : (config.reasoningEffort ?? "auto");
  const style = options.style ?? anthropicThinkingStyle(config.model);
  const cap = anthropicOutputCap(config.model);

  let thinking: Record<string, unknown> | null = null;
  let outputEffort: string | null = null;
  let maxTokens = config.maxTokens;
  if (style === "budget") {
    const budget =
      REASONING_EFFORT_LEVELS.find((lvl) => lvl.id === effort)
        ?.anthropicBudget ?? null;
    if (budget) {
      maxTokens = Math.min(cap, Math.max(config.maxTokens, budget + 4096));
      const usable = Math.min(budget, Math.max(1024, maxTokens - 2048));
      thinking = { type: "enabled", budget_tokens: usable };
    }
  } else if (effort === "off") {
    thinking = { type: "disabled" };
  } else if (effort !== "auto") {
    thinking = { type: "adaptive" };
    outputEffort = effort === "minimal" ? "low" : effort;
    maxTokens = Math.min(
      cap,
      Math.max(
        config.maxTokens,
        ADAPTIVE_OUTPUT_FLOOR[effort] ?? config.maxTokens,
      ),
    );
  }
  const thinkingActive = thinking !== null && thinking["type"] !== "disabled";
  // Signed thinking must precede tool_use whenever the model is allowed to think.
  const replayThinking = style === "budget" ? thinkingActive : effort !== "off";

  const systemParts: string[] = [];
  const anthropicMessages: Array<{
    role: "user" | "assistant";
    content: Array<Record<string, unknown>>;
  }> = [];

  const pushBlock = (
    role: "user" | "assistant",
    block: Record<string, unknown>,
  ): void => {
    const last = anthropicMessages.at(-1);
    if (last && last.role === role) {
      last.content.push(block);
    } else {
      anthropicMessages.push({ role, content: [block] });
    }
  };

  for (const msg of messages) {
    if (msg.role === "system") {
      if (msg.content?.trim()) systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "user") {
      const hasImages = Boolean(msg.images && msg.images.length > 0);
      const userText =
        hasImages && options.disableImages
          ? `${nonBlankText(msg.content, "(attached image)")}\n\n${describeAttachedImagesFallback(msg.images!)}`
          : nonBlankText(msg.content, "(empty message)");
      pushBlock("user", {
        type: "text",
        text: userText,
      });
      if (hasImages && !options.disableImages) {
        for (const img of msg.images!) {
          pushBlock("user", {
            type: "image",
            source: {
              type: "base64",
              media_type: img.mimeType,
              data: img.data,
            },
          });
        }
      }
      continue;
    }
    if (msg.role === "assistant") {
      if (replayThinking && msg.thinking_blocks) {
        for (const block of msg.thinking_blocks)
          pushBlock("assistant", { ...block });
      }
      const hasCalls = Boolean(msg.tool_calls && msg.tool_calls.length > 0);
      if (msg.content && msg.content.trim().length > 0) {
        pushBlock("assistant", { type: "text", text: msg.content });
      } else if (!hasCalls) {
        pushBlock("assistant", { type: "text", text: "(no content)" });
      }
      for (const tc of msg.tool_calls ?? []) {
        pushBlock("assistant", {
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: safeParseJsonObject(tc.function.arguments),
        });
      }
      continue;
    }
    if (msg.role === "tool") {
      pushBlock("user", {
        type: "tool_result",
        tool_use_id: msg.tool_call_id ?? "call_0",
        content: nonBlankText(msg.content, "(empty tool result)"),
      });
    }
  }

  const lastBlock = anthropicMessages.at(-1)?.content.at(-1);
  if (lastBlock) lastBlock["cache_control"] = EPHEMERAL_CACHE;

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: maxTokens,
    messages: anthropicMessages,
    stream: true,
  };
  if (systemParts.length > 0) {
    body["system"] = [
      {
        type: "text",
        text: systemParts.join("\n\n"),
        cache_control: EPHEMERAL_CACHE,
      },
    ];
  }
  if (thinking) body["thinking"] = thinking;
  if (outputEffort) body["output_config"] = { effort: outputEffort };
  if (!thinkingActive && config.temperature !== null)
    body["temperature"] = config.temperature;
  if (tools.length > 0) {
    body["tools"] = tools.map((t, index) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
      ...(index === tools.length - 1 ? { cache_control: EPHEMERAL_CACHE } : {}),
    }));
  }
  return body;
};

/**
 * Serialize history for OpenAI-compatible `/chat/completions`, echoing
 * `reasoning_content` only on assistant tool-call messages after the latest user
 * message (the active tool loop), as DeepSeek/Kimi thinking + tools require.
 */
export const toOpenAiMessages = (
  messages: readonly ChatMessage[],
  reasoningPassback: boolean,
  imageInputs = true,
): Array<Record<string, unknown>> => {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === "user") {
      lastUser = i;
      break;
    }
  }
  return messages.map((msg, index) => {
    const hasImages =
      msg.role === "user" && Boolean(msg.images && msg.images.length > 0);
    const content: unknown = hasImages
      ? imageInputs
        ? [
            { type: "text", text: msg.content ?? "" },
            ...msg.images!.map((img) => ({
              type: "image_url",
              image_url: {
                url: `data:${img.mimeType};base64,${img.data}`,
                ...(img.detail ? { detail: img.detail } : {}),
              },
            })),
          ]
        : `${msg.content ? `${msg.content}\n\n` : ""}${describeAttachedImagesFallback(msg.images!)}`
      : msg.content;
    const out: Record<string, unknown> = { role: msg.role, content };
    if (msg.tool_calls && msg.tool_calls.length > 0)
      out["tool_calls"] = msg.tool_calls;
    if (msg.tool_call_id) out["tool_call_id"] = msg.tool_call_id;
    if (
      reasoningPassback &&
      index > lastUser &&
      msg.role === "assistant" &&
      msg.tool_calls &&
      msg.tool_calls.length > 0 &&
      msg.reasoning_content
    ) {
      out["reasoning_content"] = msg.reasoning_content;
    }
    return out;
  });
};

const normalizeAnthropicStopReason = (raw: unknown): string | null => {
  if (typeof raw !== "string" || !raw) return null;
  if (raw === "tool_use") return "tool_calls";
  if (raw === "end_turn" || raw === "stop_sequence") return "stop";
  if (raw === "max_tokens") return "length";
  return raw;
};

/**
 * Effort values to try per level, closest first. Endpoints differ (`minimal` only on early
 * GPT-5, `none` on 5.1+, `xhigh` on newest models), so a rejected value steps down the ladder
 * before reasoning parameters are dropped entirely.
 */
const EFFORT_LADDER: Readonly<Record<string, readonly string[]>> = {
  off: ["none", "minimal"],
  minimal: ["minimal", "low"],
  low: ["low"],
  medium: ["medium"],
  high: ["high"],
  xhigh: ["xhigh", "high"],
};

const reasoningFragments = (
  effort: string,
  openRouter: boolean,
): Array<Record<string, unknown>> => {
  if (openRouter && effort === "off")
    return [{ reasoning: { enabled: false } }];
  const values = EFFORT_LADDER[effort] ?? [];
  return values.map((value) =>
    openRouter ? { reasoning: { effort: value } } : { reasoning_effort: value },
  );
};

type OpenAiExtra =
  | "streamUsage"
  | "reasoningParams"
  | "reasoningPassback"
  | "imageInputs";

const UNKNOWN_PARAMETER_DETAIL =
  /unknown (field|param|argument|name)|unrecognized|unsupported (param|field|argument|value)|extra (fields|inputs)|not permitted|additional properties|unexpected (field|keyword|param|argument)/i;

/**
 * Multi-protocol streaming LLM client supporting OpenAI-compatible `/chat/completions`
 * (30+ cloud, router & local providers) and native Anthropic `/v1/messages`, with
 * transient-failure retries, an inactivity watchdog, and per-endpoint compatibility memory.
 */
export class ModelClient implements ModelPort {
  readonly attemptAccounting = true;
  private readonly requestScope = new AsyncLocalStorage<{maxOutputTokens?: number; accounting?: ModelAttemptAccounting}>();
  /** Optional request extras an endpoint accepted so far; flipped off once it rejects them. */
  private readonly compat: Record<OpenAiExtra, boolean> = {
    streamUsage: true,
    reasoningParams: true,
    reasoningPassback: true,
    imageInputs: true,
  };
  /** Index into the reasoning-effort fallback ladder an endpoint accepted so far. */
  private effortStep = 0;
  /** Anthropic reasoning dialect; flipped once if the endpoint rejects the first guess. */
  private anthropicStyle: AnthropicThinkingStyle | null = null;
  private anthropicReasoningOff = false;
  private anthropicImagesOff = false;

  constructor(private readonly config: ModelConfig) {}

  get model(): string {
    return this.config.model;
  }

  /**
   * One-shot, tool-free completion used for compaction summaries: capped output, reasoning off,
   * and no sharing of this client's compatibility memory with the summarizer's settings.
   */
  async summarize(
    system: string,
    user: string,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    return (await this.summarizeDetailed(system, user, maxTokens, signal)).summary;
  }

  async summarizeDetailed(system: string, user: string, maxTokens: number, signal?: AbortSignal, limits?: ModelRequestLimits): Promise<SummaryResult> {
    const config: ModelConfig = {
      ...this.config,
      maxTokens,
      temperature: null,
      reasoningEffort: "off",
    };
    const client = new ModelClient(config);
    let text = "";
    const result = await client.stream(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      [],
      signal,
      (delta) => {
        text += delta;
      },
      undefined,
      undefined,
      undefined,
      () => {
        text = "";
      },
      limits,
    );
    const out = (result.content || text).trim();
    if (!out) throw new Error("summarizer returned no text");
    if (result.finishReason !== "stop") throw new Error(`summarizer returned incomplete output (${result.finishReason ?? "unknown"})`);
    return {summary: out, usage: result.usage};
  }

  /**
   * Custom remote text summarization. Native /responses/compact returns encrypted
   * Responses items; Chat Completions and Anthropic transports cannot replay them.
   */
  async compactRemote(
    system: string,
    user: string,
    maxTokens: number,
    signal?: AbortSignal,
    customEndpoint?: string | null,
  ): Promise<string> {
    return (await this.compactRemoteDetailed(system, user, maxTokens, signal, customEndpoint)).summary;
  }

  async compactRemoteDetailed(system: string, user: string, maxTokens: number, signal?: AbortSignal, endpoint?: string | null, limits?: ModelRequestLimits): Promise<SummaryResult> {
    if (!endpoint?.trim()) return this.compactRemoteValue(system, user, maxTokens, signal, endpoint);
    const accounting = limits?.accounting;
    const maximum = accounting ? await accounting.beforeAttempt(this.model, this.capabilities.contextWindow, maxTokens) : Math.min(maxTokens, limits?.maxOutputTokens ?? maxTokens);
    try {
      const result = await this.compactRemoteValue(system, user, maximum, signal, endpoint);
      await accounting?.completed(result.usage); return result;
    } catch (error) { await accounting?.failed(error); throw error; }
  }

  private async compactRemoteValue(system: string, user: string, maxTokens: number, signal?: AbortSignal, customEndpoint?: string | null): Promise<SummaryResult> {
    signal?.throwIfAborted();
    const url = customEndpoint?.trim();
    if (!url) {
      throw new ModelCapabilityError(
        "Native Responses compaction is unsupported by the active Chat Completions/Anthropic transport. Configure a custom text-summary endpoint or use soft compaction.",
      );
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      ...this.config.headers,
    };
    if (this.config.apiKey && !("api-key" in headers)) {
      headers["authorization"] = `Bearer ${this.config.apiKey}`;
    }
    const payload = {
          model: this.config.model,
          systemPrompt: system,
          prompt: user,
          maxTokens,
        };
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]) : AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(
        `remote compaction HTTP ${response.status}: ${detail || response.statusText}`,
      );
    }
    const parsed: unknown = await response.json();
    const record = asRecord(parsed);
    const outputItems = asArray(record?.["output"]);
    if (record?.["object"] === "response.compaction" || outputItems.some((item) => {
      const obj = asRecord(item);
      return obj?.["type"] === "compaction" || typeof obj?.["encrypted_content"] === "string";
    })) throw new Error("Native opaque Responses compaction cannot be used as a text summary by this transport");
    const directSummary =
      asString(record?.["summary"]) ||
      asString(record?.["compaction_summary"]) ||
      asString(record?.["output_text"]);
    if (directSummary.trim()) return {summary: directSummary.trim(), usage: usageOf(record?.["usage"])};

    const extracted: string[] = [];
    for (const item of outputItems) {
      const obj = asRecord(item);
      if (!obj || obj["type"] !== "message" || obj["role"] !== "assistant") continue;
      for (const block of asArray(obj["content"])) {
        const b = asRecord(block);
        const txt = b?.["type"] === "output_text" ? asString(b["text"]) : "";
        if (txt.trim()) extracted.push(txt.trim());
      }
    }
    const joined = extracted.join("\n\n").trim();
    if (!joined)
      throw new Error("remote compaction endpoint returned no summary text");
    return {summary: joined, usage: usageOf(record?.["usage"])};
  }

  get providerId(): string {
    return this.config.providerId ?? "custom";
  }

  get capabilities(): ModelCapabilities {
    return resolveModelCapabilities(this.model, this.providerId, {...this.config.modelMetadata, ...this.config.capabilities}, this.config.capabilities?.contextWindow ? "operator" : "provider-metadata");
  }

  get outputReserveTokens(): number {
    const requested = this.config.protocol === "anthropic-messages"
      ? Number(buildAnthropicPayload([], [], this.config)["max_tokens"])
      : this.config.maxTokens;
    return Math.max(1, Math.min(requested, this.capabilities.maxOutputTokens ?? requested));
  }

  private get requestOutputLimit(): number {
    return Math.max(1, Math.min(this.capabilities.maxOutputTokens ?? Infinity, this.requestScope.getStore()?.maxOutputTokens ?? Infinity));
  }

  get providerName(): string {
    return this.config.providerName ?? "Custom";
  }

  get endpoint(): string {
    return this.config.protocol === "anthropic-messages"
      ? `${this.config.baseUrl}/messages`
      : `${this.config.baseUrl}/chat/completions`;
  }

  /**
   * Stream one model step.
   * - Network outages (DNS/socket drop, `fetch failed`, `terminated`, mid-stream TCP reset/truncation)
   *   activate Network Guard: rolls back any partial step stream (`onStreamReset`), pauses the step,
   *   repeatedly pings the endpoint (`onNetworkStatus`), and automatically resumes once connectivity returns.
   * - Server HTTP transient errors (429/5xx/529) retry with backoff and `Retry-After` hints while no
   *   tokens have been emitted.
   */
  async stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal | undefined,
    onText: (delta: string) => void,
    onReasoning?: (delta: string) => void,
    onRetry?: (notice: RetryNotice) => void,
    onNetworkStatus?: (notice: NetworkStatusNotice) => void,
    onStreamReset?: () => void,
    limits?: ModelRequestLimits,
  ): Promise<StreamResult> {
    return this.requestScope.run({...limits}, () => this.streamRequest(messages, tools, signal, onText, onReasoning, onRetry, onNetworkStatus, onStreamReset));
  }

  private async streamRequest(messages: ChatMessage[], tools: ToolDefinition[], signal: AbortSignal | undefined, onText: (delta: string) => void, onReasoning?: (delta: string) => void, onRetry?: (notice: RetryNotice) => void, onNetworkStatus?: (notice: NetworkStatusNotice) => void, onStreamReset?: () => void): Promise<StreamResult> {
    const notifyNetwork = onNetworkStatus ?? this.config.onNetworkStatus;
    let httpAttempt = 0;
    let probeAttempt = 0;
    let outageStartedAt: number | null = null;

    while (true) {
      let emitted = false;
      const textSink = (delta: string): void => {
        emitted = true;
        onText(delta);
      };
      const reasoningSink = (delta: string): void => {
        emitted = true;
        onReasoning?.(delta);
      };
      const accounting = this.requestScope.getStore()?.accounting;
      if (accounting) this.requestScope.getStore()!.maxOutputTokens = await accounting.beforeAttempt(this.model, this.capabilities.contextWindow, this.outputReserveTokens);
      try {
        const result = await this.streamOnce(
          messages,
          tools,
          signal,
          textSink,
          reasoningSink,
        );
        await accounting?.completed(result.usage);
        return result;
      } catch (error) {
        await accounting?.failed(error);
        if (signal?.aborted) {
          throw error;
        }
        if (isNetworkOutageError(error)) {
          if (emitted) {
            onStreamReset?.();
          }
          if (outageStartedAt === null) {
            outageStartedAt = Date.now();
          }
          probeAttempt += 1;
          probeAttempt = await this.waitForNetworkRecovery(
            probeAttempt,
            outageStartedAt,
            error,
            signal,
            notifyNetwork,
          );
          continue;
        }
        if (
          emitted ||
          httpAttempt >= MAX_RETRIES ||
          !isRetryableModelError(error)
        ) {
          throw error;
        }
        const delayMs = retryDelayMs(httpAttempt, error);
        httpAttempt += 1;
        onRetry?.({
          attempt: httpAttempt,
          maxRetries: MAX_RETRIES,
          delayMs,
          reason: retryReason(error),
        });
        await abortableSleep(delayMs, signal);
      }
    }
  }

  private async waitForNetworkRecovery(
    initialAttempt: number,
    outageStartedAt: number,
    initialError: unknown,
    signal: AbortSignal | undefined,
    notifyNetwork: ((notice: NetworkStatusNotice) => void) | undefined,
  ): Promise<number> {
    const target = formatPingTarget(this.config.baseUrl);
    const baseIntervalMs = Math.max(
      10,
      this.config.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
    );
    const maxWaitMs = Math.max(
      50,
      this.config.maxNetworkWaitMs ?? DEFAULT_MAX_NETWORK_WAIT_MS,
    );
    const probeFn =
      this.config.networkProbe ??
      ((url: string, sig?: AbortSignal) =>
        probeEndpointConnectivity(
          url,
          sig,
          Math.min(3_000, Math.max(250, baseIntervalMs * 2)),
        ));

    let attempt = initialAttempt;
    let currentReason = networkOutageReason(initialError);

    while (true) {
      const elapsedBeforeWait = Math.max(0, Date.now() - outageStartedAt);
      if (elapsedBeforeWait >= maxWaitMs) {
        throw initialError;
      }
      const waitMs = Math.min(
        8_000,
        Math.round(baseIntervalMs * Math.min(4, 1 + (attempt - 1) * 0.5)),
      );
      notifyNetwork?.({
        state: "offline",
        target,
        attempt,
        reason: currentReason,
        offlineDurationMs: elapsedBeforeWait,
        nextPingInMs: waitMs,
        latencyMs: null,
      });
      await abortableSleep(waitMs, signal);

      const elapsedBeforePing = Math.max(0, Date.now() - outageStartedAt);
      notifyNetwork?.({
        state: "pinging",
        target,
        attempt,
        reason: currentReason,
        offlineDurationMs: elapsedBeforePing,
        nextPingInMs: null,
        latencyMs: null,
      });

      const res = await probeFn(this.config.baseUrl, signal);
      if (res.ok) {
        notifyNetwork?.({
          state: "restored",
          target,
          attempt,
          reason: "ok",
          offlineDurationMs: Math.max(0, Date.now() - outageStartedAt),
          nextPingInMs: null,
          latencyMs: Math.max(1, Math.round(res.latencyMs)),
        });
        return attempt;
      }

      if (res.reason) {
        currentReason = res.reason;
      }
      attempt += 1;
    }
  }

  private async streamOnce(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal | undefined,
    onText: (delta: string) => void,
    onReasoning: (delta: string) => void,
  ): Promise<StreamResult> {
    const watchdog = createWatchdog(this.config.timeoutMs, signal);
    try {
      return this.config.protocol === "anthropic-messages"
        ? await this.streamAnthropic(
            messages,
            tools,
            watchdog,
            onText,
            onReasoning,
          )
        : await this.streamOpenAi(
            messages,
            tools,
            watchdog,
            onText,
            onReasoning,
          );
    } catch (error) {
      const reason: unknown = watchdog.signal.reason;
      if (!signal?.aborted && reason instanceof ModelStallError) throw reason;
      throw error;
    } finally {
      watchdog.dispose();
    }
  }

  private openAiBody(
    messages: readonly ChatMessage[],
    tools: readonly ToolDefinition[],
  ): { body: Record<string, unknown>; extras: OpenAiExtra[] } {
    const extras: OpenAiExtra[] = [];
    const useCompletionTokens = usesOpenAiCompletionTokens(
      this.config.baseUrl,
      this.config.model,
    );
    const wireMessages = toOpenAiMessages(
      messages,
      this.compat.reasoningPassback,
      this.compat.imageInputs,
    );
    if (
      this.compat.reasoningPassback &&
      wireMessages.some((m) => "reasoning_content" in m)
    ) {
      extras.push("reasoningPassback");
    }
    if (
      this.compat.imageInputs &&
      wireMessages.some((m) => Array.isArray(m["content"]))
    ) {
      extras.push("imageInputs");
    }
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: wireMessages,
      stream: true,
      [useCompletionTokens ? "max_completion_tokens" : "max_tokens"]:
        Math.min(this.config.maxTokens, this.requestOutputLimit),
    };
    if (this.compat.streamUsage) {
      body["stream_options"] = { include_usage: true };
      extras.push("streamUsage");
    }
    if (tools.length > 0) {
      body["tools"] = tools;
      body["tool_choice"] = "auto";
    }
    if (this.config.temperature !== null && !useCompletionTokens) {
      body["temperature"] = this.config.temperature;
    }
    const effort = this.config.reasoningEffort ?? "auto";
    if (effort !== "auto" && this.compat.reasoningParams) {
      const fragments = reasoningFragments(
        effort,
        this.config.baseUrl.toLowerCase().includes("openrouter.ai"),
      );
      const fragment =
        fragments[Math.min(this.effortStep, fragments.length - 1)];
      if (fragment) {
        extras.push("reasoningParams");
        Object.assign(body, fragment);
      }
    }
    return { body, extras };
  }

  /** Advance to the next effort value for this level; false when the ladder is exhausted. */
  private stepEffortLadder(): boolean {
    const effort = this.config.reasoningEffort ?? "auto";
    const fragments = reasoningFragments(
      effort,
      this.config.baseUrl.toLowerCase().includes("openrouter.ai"),
    );
    if (this.effortStep + 1 < fragments.length) {
      this.effortStep += 1;
      return true;
    }
    return false;
  }

  /** Disable request extras an endpoint rejected; returns true when a retry can differ. */
  private dropRejectedExtras(
    detail: string,
    extras: readonly OpenAiExtra[],
  ): boolean {
    const named: OpenAiExtra[] = [];
    if (
      extras.includes("streamUsage") &&
      /stream_options|include_usage/i.test(detail)
    )
      named.push("streamUsage");
    if (
      extras.includes("reasoningPassback") &&
      /reasoning_content/i.test(detail)
    )
      named.push("reasoningPassback");
    if (
      extras.includes("imageInputs") &&
      /image_url|image|vision|multimodal|content.*must be a string|expected string/i.test(
        detail,
      )
    ) {
      named.push("imageInputs");
    }
    let stepped = false;
    if (
      extras.includes("reasoningParams") &&
      /reasoning_effort|reasoning\b(?!_content)|thinking|effort/i.test(detail)
    ) {
      if (this.stepEffortLadder()) stepped = true;
      else named.push("reasoningParams");
    }
    if (
      named.length === 0 &&
      !stepped &&
      UNKNOWN_PARAMETER_DETAIL.test(detail)
    ) {
      for (const extra of extras) {
        if (extra === "reasoningParams" && this.stepEffortLadder())
          stepped = true;
        else named.push(extra);
      }
    }
    for (const extra of named) this.compat[extra] = false;
    return named.length > 0 || stepped;
  }

  private async streamOpenAi(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    watchdog: Watchdog,
    onText: (delta: string) => void,
    onReasoning: (delta: string) => void,
  ): Promise<StreamResult> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...this.config.headers,
    };
    if (this.config.apiKey && !("api-key" in headers)) {
      headers["authorization"] = `Bearer ${this.config.apiKey}`;
    }

    for (let fallback = 0; ; fallback += 1) {
      const { body, extras } = this.openAiBody(messages, tools);
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: watchdog.signal,
      });
      watchdog.touch();
      if (response.ok) {
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream") || !response.body) {
          return this.readOpenAiNonStreaming(response, onText, onReasoning);
        }
        return this.readOpenAiStreaming(
          response.body,
          watchdog,
          onText,
          onReasoning,
        );
      }
      const error = await httpError("model", response);
      if (
        (response.status === 400 || response.status === 422) &&
        extras.length > 0 &&
        fallback < 2 &&
        this.dropRejectedExtras(error.message, extras)
      ) {
        continue;
      }
      throw error;
    }
  }

  private async readOpenAiNonStreaming(
    response: Response,
    onText: (delta: string) => void,
    onReasoning: (delta: string) => void,
  ): Promise<StreamResult> {
    const parsed: unknown = await response.json();
    const record = asRecord(parsed);
    if (record?.["error"]) throw streamError("model", record["error"]);
    const choice = asRecord(asArray(record?.["choices"])[0]);
    const messageRecord = asRecord(choice?.["message"]);
    const reasoning = reasoningTextOf(messageRecord);
    const content = asString(messageRecord?.["content"]);
    if (reasoning.length > 0) onReasoning(reasoning);
    if (content.length > 0) onText(content);
    const fieldReasoning = asString(messageRecord?.["reasoning_content"]);
    return {
      content,
      reasoning,
      toolCalls: callsFromMessage(messageRecord),
      finishReason:
        typeof choice?.["finish_reason"] === "string"
          ? choice["finish_reason"]
          : null,
      usage: usageOf(record?.["usage"]),
      reasoningContent: fieldReasoning || null,
      thinkingBlocks: [],
    };
  }

  private async readOpenAiStreaming(
    body: ReadableStream<Uint8Array>,
    watchdog: Watchdog,
    onText: (delta: string) => void,
    onReasoning: (delta: string) => void,
  ): Promise<StreamResult> {
    let content = "";
    let reasoning = "";
    let fieldReasoning = "";
    let finishReason: string | null = null;
    let usage: Usage | null = null;
    const calls = new Map<number, AccumulatedCall>();
    const idToSlot = new Map<string, number>();
    let fallbackIndex = 10_000;

    const resolveCallSlot = (call: Record<string, unknown>): number => {
      const explicit = asNumber(call["index"]);
      const callId =
        typeof call["id"] === "string" && call["id"] ? call["id"] : null;
      if (explicit !== null) {
        if (callId) idToSlot.set(callId, explicit);
        return explicit;
      }
      if (callId) {
        const existing = idToSlot.get(callId);
        if (existing !== undefined) return existing;
        const slot = fallbackIndex;
        fallbackIndex += 1;
        idToSlot.set(callId, slot);
        return slot;
      }
      const fn = asRecord(call["function"]);
      const hasNewName =
        typeof fn?.["name"] === "string" && fn["name"].length > 0;
      if (!hasNewName && calls.size > 0) {
        const lastKey = [...calls.keys()].at(-1);
        if (lastKey !== undefined) return lastKey;
      }
      const slot = fallbackIndex;
      fallbackIndex += 1;
      return slot;
    };

    let sawDone = false;
    await readSse(body, watchdog, (data) => {
      if (!data) return;
      if (data === "[DONE]") {
        sawDone = true;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      const record = asRecord(parsed);
      if (!record) return;
      if (record["error"] && asArray(record["choices"]).length === 0) {
        throw streamError("model", record["error"]);
      }
      usage = usageOf(record["usage"]) ?? usage;
      for (const value of asArray(record["choices"])) {
        const choice = asRecord(value);
        if (!choice) continue;
        const delta = asRecord(choice["delta"]);
        if (delta) {
          const thought = reasoningTextOf(delta);
          if (thought.length > 0) {
            reasoning += thought;
            if (typeof delta["reasoning_content"] === "string")
              fieldReasoning += thought;
            onReasoning(thought);
          }
          const text = delta["content"];
          if (typeof text === "string" && text.length > 0) {
            content += text;
            onText(text);
          }
          for (const rawCall of asArray(delta["tool_calls"])) {
            const call = asRecord(rawCall);
            if (!call) continue;
            const slot = resolveCallSlot(call);
            const fn = asRecord(call["function"]);
            const current = calls.get(slot) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (typeof call["id"] === "string" && call["id"])
              current.id = call["id"];
            if (fn) {
              if (typeof fn["name"] === "string" && fn["name"])
                current.name = fn["name"];
              if (typeof fn["arguments"] === "string")
                current.arguments += fn["arguments"];
            }
            calls.set(slot, current);
          }
        }
        if (typeof choice["finish_reason"] === "string")
          finishReason = choice["finish_reason"];
      }
    });

    const toolCalls: ChatToolCall[] = [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .filter(([, call]) => call.name.length > 0)
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        type: "function",
        function: { name: call.name, arguments: call.arguments || "{}" },
      }));

    if (!finishReason && !sawDone) {
      throw new ModelRequestError(
        "model stream ended before completion (connection dropped mid-stream)",
        null,
        true,
        null,
      );
    }
    if (!finishReason && !content && !reasoning && toolCalls.length === 0) {
      throw new ModelRequestError(
        "model stream ended before any response was produced",
        null,
        true,
        null,
      );
    }
    return {
      content,
      reasoning,
      toolCalls,
      finishReason,
      usage,
      reasoningContent: fieldReasoning || null,
      thinkingBlocks: [],
    };
  }

  private async streamAnthropic(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    watchdog: Watchdog,
    onText: (delta: string) => void,
    onReasoning: (delta: string) => void,
  ): Promise<StreamResult> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      "anthropic-version": "2023-06-01",
      ...this.config.headers,
    };
    if (this.config.apiKey) {
      headers["x-api-key"] = this.config.apiKey;
    }

    let response: Response;
    for (let attempt = 0; ; attempt += 1) {
      const style =
        this.anthropicStyle ?? anthropicThinkingStyle(this.config.model);
      const payload = buildAnthropicPayload(messages, tools, this.config, {
        style,
        disableReasoning: this.anthropicReasoningOff,
        disableImages: this.anthropicImagesOff,
      });
      const outputLimit = this.requestOutputLimit;
      if (Number.isFinite(outputLimit) && Number(payload["max_tokens"]) > outputLimit) {
        payload["max_tokens"] = outputLimit;
        const thinking = asRecord(payload["thinking"]);
        if (thinking?.["type"] === "enabled") {
          const budget = Math.min(Number(thinking["budget_tokens"]), outputLimit - Math.min(this.config.maxTokens, Math.floor(outputLimit / 2)));
          payload["thinking"] = budget >= 1024 ? {type: "enabled", budget_tokens: budget} : {type: "disabled"};
        }
      }
      response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: watchdog.signal,
      });
      watchdog.touch();
      if (response.ok) break;
      const error = await httpError("Anthropic", response);
      const reasoningSent = "thinking" in payload || "output_config" in payload;
      const imagesSent =
        !this.anthropicImagesOff &&
        messages.some((m) => m.images && m.images.length > 0);
      if (
        (response.status === 400 || response.status === 422) &&
        imagesSent &&
        attempt < 2 &&
        /image|vision|media_type|multimodal/i.test(error.message)
      ) {
        this.anthropicImagesOff = true;
        continue;
      }
      if (
        response.status === 400 &&
        reasoningSent &&
        attempt < 2 &&
        /budget_tokens|adaptive|thinking|output_config|effort/i.test(
          error.message,
        )
      ) {
        // Wrong dialect guess (model naming is not a reliable signal): flip once, then stop sending reasoning.
        if (this.anthropicStyle === null)
          this.anthropicStyle = style === "budget" ? "adaptive" : "budget";
        else this.anthropicReasoningOff = true;
        continue;
      }
      throw error;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      const parsed: unknown = await response.json();
      const rec = asRecord(parsed);
      if (rec?.["type"] === "error")
        throw streamError("Anthropic", rec["error"]);
      let content = "";
      let reasoning = "";
      const toolCalls: ChatToolCall[] = [];
      const thinkingBlocks: ThinkingBlock[] = [];
      for (const rawBlock of asArray(rec?.["content"])) {
        const b = asRecord(rawBlock);
        if (!b) continue;
        if (b["type"] === "text" && typeof b["text"] === "string") {
          content += b["text"];
          onText(b["text"]);
        } else if (
          b["type"] === "thinking" &&
          typeof b["thinking"] === "string"
        ) {
          reasoning += b["thinking"];
          onReasoning(b["thinking"]);
          const signature = asString(b["signature"]);
          if (signature)
            thinkingBlocks.push({
              type: "thinking",
              thinking: b["thinking"],
              signature,
            });
        } else if (b["type"] === "redacted_thinking") {
          thinkingBlocks.push({
            type: "redacted_thinking",
            data: asString(b["data"]),
          });
        } else if (b["type"] === "tool_use") {
          toolCalls.push({
            id: asString(b["id"]) || `call_${toolCalls.length}`,
            type: "function",
            function: {
              name: asString(b["name"]),
              arguments: JSON.stringify(b["input"] ?? {}),
            },
          });
        }
      }
      return {
        content,
        reasoning,
        toolCalls,
        finishReason: normalizeAnthropicStopReason(rec?.["stop_reason"]),
        usage: usageOf(rec?.["usage"]),
        reasoningContent: null,
        thinkingBlocks,
      };
    }

    let content = "";
    let reasoning = "";
    let finishReason: string | null = null;
    const usageRecord: Record<string, unknown> = {};
    const toolBlocks = new Map<number, AccumulatedCall>();
    const thinkingByIndex = new Map<number, ThinkingBlock>();

    const mergeUsage = (value: unknown): void => {
      const u = asRecord(value);
      if (!u) return;
      for (const [key, entry] of Object.entries(u)) {
        if (typeof entry === "number") usageRecord[key] = entry;
      }
    };

    let sawMessageStop = false;
    await readSse(response.body, watchdog, (data) => {
      if (!data) return;
      if (data === "[DONE]") {
        sawMessageStop = true;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      const event = asRecord(parsed);
      if (!event) return;
      const type = asString(event["type"]);

      if (type === "error") {
        throw streamError("Anthropic", event["error"]);
      } else if (type === "message_stop") {
        sawMessageStop = true;
      } else if (type === "message_start") {
        mergeUsage(asRecord(event["message"])?.["usage"]);
      } else if (type === "content_block_start") {
        const index = asNumber(event["index"]) ?? 0;
        const block = asRecord(event["content_block"]);
        if (block?.["type"] === "tool_use") {
          const initialInput = asRecord(block["input"]);
          const hasInitialKeys =
            initialInput && Object.keys(initialInput).length > 0;
          toolBlocks.set(index, {
            id: asString(block["id"]) || `call_${index}`,
            name: asString(block["name"]),
            arguments: hasInitialKeys ? JSON.stringify(initialInput) : "",
          });
        } else if (block?.["type"] === "thinking") {
          thinkingByIndex.set(index, {
            type: "thinking",
            thinking: asString(block["thinking"]),
            signature: asString(block["signature"]),
          });
        } else if (block?.["type"] === "redacted_thinking") {
          thinkingByIndex.set(index, {
            type: "redacted_thinking",
            data: asString(block["data"]),
          });
        }
      } else if (type === "content_block_delta") {
        const index = asNumber(event["index"]) ?? 0;
        const delta = asRecord(event["delta"]);
        if (!delta) return;
        const dType = asString(delta["type"]);
        if (dType === "text_delta" && typeof delta["text"] === "string") {
          content += delta["text"];
          onText(delta["text"]);
        } else if (
          dType === "thinking_delta" &&
          typeof delta["thinking"] === "string"
        ) {
          reasoning += delta["thinking"];
          const block = thinkingByIndex.get(index);
          if (block?.type === "thinking") block.thinking += delta["thinking"];
          onReasoning(delta["thinking"]);
        } else if (
          dType === "signature_delta" &&
          typeof delta["signature"] === "string"
        ) {
          const block = thinkingByIndex.get(index);
          if (block?.type === "thinking") block.signature += delta["signature"];
        } else if (
          dType === "input_json_delta" &&
          typeof delta["partial_json"] === "string"
        ) {
          const existing = toolBlocks.get(index);
          if (existing) existing.arguments += delta["partial_json"];
        }
      } else if (type === "message_delta") {
        const delta = asRecord(event["delta"]);
        finishReason =
          normalizeAnthropicStopReason(delta?.["stop_reason"]) ?? finishReason;
        mergeUsage(event["usage"]);
      }
    });

    const toolCalls: ChatToolCall[] = [...toolBlocks.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, call]) => call.name.length > 0)
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        type: "function",
        function: { name: call.name, arguments: call.arguments || "{}" },
      }));

    // Unsigned thinking cannot be replayed; the API rejects it.
    const thinkingBlocks = [...thinkingByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, block]) => block)
      .filter(
        (block) =>
          block.type === "redacted_thinking" || block.signature.length > 0,
      );

    if (!finishReason && !sawMessageStop) {
      throw new ModelRequestError(
        "Anthropic stream ended before completion (connection dropped mid-stream)",
        null,
        true,
        null,
      );
    }
    if (!finishReason && !content && !reasoning && toolCalls.length === 0) {
      throw new ModelRequestError(
        "Anthropic stream ended before any response was produced",
        null,
        true,
        null,
      );
    }
    return {
      content,
      reasoning,
      toolCalls,
      finishReason,
      usage: usageOf(usageRecord),
      reasoningContent: null,
      thinkingBlocks,
    };
  }
}

export interface FailoverCandidate {
  readonly spec: string;
  readonly client: ModelPort;
}

/**
 * Multi-provider failover wrapper implementing `ModelPort`.
 * Automatically switches to the next configured fallback model when the active model fails
 * with a non-abort error (quota exhaustion, authentication failure, server outage, or network timeout),
 * rolling back any partial stream fragments via `onStreamReset` and preserving full conversation history.
 */
export class FailoverModelClient implements ModelPort {
  readonly attemptAccounting = true;
  private activeIdx = 0;
  private readonly candidates: readonly FailoverCandidate[];

  constructor(
    candidates: readonly FailoverCandidate[],
    private readonly onFailover?: (notice: FailoverNotice) => void,
  ) {
    if (candidates.length === 0) {
      throw new Error("FailoverModelClient requires at least one candidate.");
    }
    this.candidates = candidates;
  }

  get model(): string {
    return this.candidates[this.activeIdx]!.client.model;
  }

  get activeSpec(): string {
    return this.candidates[this.activeIdx]!.spec;
  }

  get providerId(): string { return this.candidates[this.activeIdx]!.client.providerId ?? "custom"; }
  get providerName(): string { return this.candidates[this.activeIdx]!.client.providerName ?? "Custom"; }
  get endpoint(): string { return this.candidates[this.activeIdx]!.client.endpoint ?? ""; }
  get capabilities(): ModelCapabilities {
    const client = this.candidates[this.activeIdx]!.client;
    return client.capabilities ?? resolveModelCapabilities(client.model, client.providerId);
  }
  get outputReserveTokens(): number { return this.candidates[this.activeIdx]!.client.outputReserveTokens ?? 4096; }

  get candidateSpecs(): readonly string[] {
    return this.candidates.map((c) => c.spec);
  }

  async stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal | undefined,
    onText: (delta: string) => void,
    onReasoning?: (delta: string) => void,
    onRetry?: (notice: RetryNotice) => void,
    onNetworkStatus?: (notice: NetworkStatusNotice) => void,
    onStreamReset?: () => void,
    limits?: ModelRequestLimits,
  ): Promise<StreamResult> {
    let lastError: unknown;
    const startIdx = this.activeIdx;
    for (let offset = 0; offset < this.candidates.length; offset += 1) {
      const idx = (startIdx + offset) % this.candidates.length;
      const current = this.candidates[idx]!;
      let emitted = false;
      let mediatedAttempt = false;
      try {
        const capabilities = current.client.capabilities ?? resolveModelCapabilities(current.client.model, current.client.providerId);
        const required = estimateRequestTokens(messages, tools) + (limits?.accounting ? 1 : Math.min(current.client.outputReserveTokens ?? 4096, limits?.maxOutputTokens ?? Infinity));
        if (required > capabilities.contextWindow) throw new ContextOverflowError(`Candidate ${current.spec} requires about ${required} tokens including output reserve, exceeding its ${capabilities.contextWindow} token window`, capabilities.contextWindow);
        let requestLimits = limits;
        if (limits?.accounting && !current.client.attemptAccounting) {
          const maximum = await limits.accounting.beforeAttempt(current.client.model, capabilities.contextWindow, current.client.outputReserveTokens ?? 4096);
          mediatedAttempt = true; requestLimits = {maxOutputTokens: maximum};
        }
        const res = await current.client.stream(
          messages,
          tools,
          signal,
          (d) => {
            emitted = true;
            onText(d);
          },
          onReasoning
            ? (r) => {
                emitted = true;
                onReasoning(r);
              }
            : undefined,
          onRetry,
          onNetworkStatus,
          onStreamReset,
          requestLimits,
        );
        if (mediatedAttempt) await limits?.accounting?.completed(res.usage);
        this.activeIdx = idx;
        return res;
      } catch (error) {
        if (mediatedAttempt) await limits?.accounting?.failed(error);
        if (error instanceof Error && error.name === "BudgetExceededError") throw error;
        if (signal?.aborted) throw error;
        lastError = error;
        if (emitted) onStreamReset?.();
        const nextOffset = offset + 1;
        if (nextOffset < this.candidates.length) {
          const nextIdx = (startIdx + nextOffset) % this.candidates.length;
          const next = this.candidates[nextIdx]!;
          this.activeIdx = nextIdx;
          const reason =
            error instanceof Error
              ? error.message.slice(0, 140)
              : String(error).slice(0, 140);
          this.onFailover?.({
            from: current.spec,
            to: next.spec,
            reason,
            candidateIndex: nextIdx + 1,
            totalCandidates: this.candidates.length,
          });
        }
      }
    }
    throw lastError;
  }

  async summarize(
    system: string,
    user: string,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    return (await this.summarizeDetailed(system, user, maxTokens, signal)).summary;
  }

  async summarizeDetailed(system: string, user: string, maxTokens: number, signal?: AbortSignal, limits?: ModelRequestLimits): Promise<SummaryResult> {
    let lastError: unknown;
    for (let offset = 0; offset < this.candidates.length; offset += 1) {
      const idx = (this.activeIdx + offset) % this.candidates.length;
      const candidate = this.candidates[idx]!;
      if (!candidate.client.summarize) continue;
      let mediatedAttempt = false;
      try {
        if (candidate.client.summarizeDetailed && candidate.client.attemptAccounting) return await candidate.client.summarizeDetailed(system, user, maxTokens, signal, limits);
        const capabilities = candidate.client.capabilities ?? resolveModelCapabilities(candidate.client.model, candidate.client.providerId);
        const maximum = limits?.accounting ? await limits.accounting.beforeAttempt(candidate.client.model, capabilities.contextWindow, maxTokens) : Math.min(maxTokens, limits?.maxOutputTokens ?? maxTokens);
        mediatedAttempt = Boolean(limits?.accounting);
        const summary = await candidate.client.summarize(system, user, maximum, signal);
        if (mediatedAttempt) await limits?.accounting?.completed(null);
        return {summary, usage: null};
      } catch (error) {
        if (mediatedAttempt) await limits?.accounting?.failed(error);
        if (error instanceof Error && error.name === "BudgetExceededError") throw error;
        if (signal?.aborted) throw error;
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    throw new Error("No candidate model supports summarize().");
  }

  async compactRemote(
    system: string,
    user: string,
    maxTokens: number,
    signal?: AbortSignal,
    customEndpoint?: string | null,
  ): Promise<string> {
    return (await this.compactRemoteDetailed(system, user, maxTokens, signal, customEndpoint)).summary;
  }

  async compactRemoteDetailed(system: string, user: string, maxTokens: number, signal?: AbortSignal, customEndpoint?: string | null, limits?: ModelRequestLimits): Promise<SummaryResult> {
    const active = this.candidates[this.activeIdx]!.client;
    if (!active.compactRemote) {
      throw new ModelCapabilityError(
        `Active model "${active.model}" does not support remote compaction.`,
      );
    }
    if (active.compactRemoteDetailed && active.attemptAccounting) return active.compactRemoteDetailed(system, user, maxTokens, signal, customEndpoint, limits);
    const capabilities = active.capabilities ?? resolveModelCapabilities(active.model, active.providerId);
    const maximum = limits?.accounting ? await limits.accounting.beforeAttempt(active.model, capabilities.contextWindow, maxTokens) : Math.min(maxTokens, limits?.maxOutputTokens ?? maxTokens);
    try { const summary = await active.compactRemote(system, user, maximum, signal, customEndpoint); await limits?.accounting?.completed(null); return {summary, usage: null}; }
    catch (error) { await limits?.accounting?.failed(error); throw error; }
  }
}
