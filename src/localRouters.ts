import { createHash } from "node:crypto";
import { boundedGet } from "./boundedHttp.js";
import { isLoopbackHost, sameEndpoint, validateCustomBaseUrl } from "./customEndpoint.js";
import {
  ROUTER_PRODUCTS,
  buildModelItems,
  extractLiveModelsFromPayload,
  type CatalogStatus,
  type ProviderModelItem,
  type ResolvedProvider,
  type RouterProduct,
} from "./providers.js";
import { asRecord, asString } from "./values.js";

export const DISCOVERY_LIMITS = {
  identityTimeoutMs: 400,
  scanBudgetMs: 1500,
  concurrency: 4,
  identityMaxBytes: 65_536,
  catalogTimeoutMs: 5000,
  customTestTimeoutMs: 8000,
  catalogMaxBytes: 4_194_304,
  catalogMaxRows: 10_000,
  catalogMaxPages: 20,
  modelIdMaxLength: 256,
  scanPositiveTtlMs: 30_000,
  scanNegativeTtlMs: 10_000,
  catalogTtlMs: 60_000,
} as const;

const DEFAULT_PORTS: readonly number[] = [20128, 20127, 20129];
const PRODUCT_ORDER: readonly RouterProduct[] = ["9router", "omniroute"];

export interface RouterCandidate {
  readonly origin: string;
  readonly apiBase: string;
  readonly explicit?: RouterProduct;
  /** Key for a saved router provider; its own bound key, never one from another provider. */
  readonly apiKey?: string;
}

const truthyEnv = (value: string | undefined): boolean => value !== undefined && /^(?:1|true|yes|on)$/i.test(value.trim());

const proxyConfigured = (env: NodeJS.ProcessEnv): boolean =>
  truthyEnv(env["NODE_USE_ENV_PROXY"]) &&
  ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some((name) => Boolean(env[name]?.trim()));

const parsePorts = (raw: string | undefined): readonly number[] => {
  if (!raw) return DEFAULT_PORTS;
  const ports: number[] = [];
  for (const piece of raw.split(",")) {
    const text = piece.trim();
    if (!/^\d{1,5}$/.test(text)) continue;
    const port = Number(text);
    if (port >= 1 && port <= 65_535 && !ports.includes(port)) ports.push(port);
  }
  return ports.length > 0 ? ports : DEFAULT_PORTS;
};

export const routerCandidates = (env: NodeJS.ProcessEnv): readonly RouterCandidate[] => {
  const out: RouterCandidate[] = [];
  for (const product of PRODUCT_ORDER) {
    const raw = env[ROUTER_PRODUCTS[product].baseUrlEnv];
    if (!raw?.trim()) continue;
    const checked = validateCustomBaseUrl(raw);
    if (checked.ok) out.push({ origin: checked.value.origin, apiBase: checked.value.baseUrl, explicit: product });
  }
  if (env["OMR_ROUTER_DISCOVERY"]?.trim() === "0" || proxyConfigured(env)) return out;
  const explicit = out.map((candidate) => candidate.origin);
  for (const port of parsePorts(env["OMR_ROUTER_PORTS"])) {
    for (const host of ["127.0.0.1", "[::1]"]) {
      const origin = `http://${host}:${port}`;
      if (explicit.some((base) => sameEndpoint(base, origin))) continue;
      out.push({ origin, apiBase: `${origin}/v1` });
    }
  }
  return out;
};

export type Fingerprint = RouterProduct | "ambiguous" | "unknown" | "unreachable";

type Probe =
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "http" }
  | { readonly kind: "network" };

const probeJson = async (url: string, signal: AbortSignal): Promise<Probe> => {
  const result = await boundedGet(url, {
    timeoutMs: DISCOVERY_LIMITS.identityTimeoutMs,
    maxBytes: DISCOVERY_LIMITS.identityMaxBytes,
    signal,
  });
  if (result.kind === "response") {
    if (result.status !== 200) return { kind: "http" };
    try {
      return { kind: "json", value: JSON.parse(result.body) as unknown };
    } catch {
      return { kind: "http" };
    }
  }
  return result.kind === "too-large" ? { kind: "http" } : { kind: "network" };
};

const plainObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? asRecord(value) : null;

/** Credential-free identity check. Values of the posture and card are never stored or followed. */
export const identifyRouter = async (origin: string, signal: AbortSignal): Promise<Fingerprint> => {
  const health = await probeJson(`${origin}/api/health`, signal);
  if (health.kind === "network") return "unreachable";
  const body = health.kind === "json" ? plainObject(health.value) : null;
  if (!body) return "unknown";
  const nineHealth = body["ok"] === true;
  const omniHealth = body["status"] === "ok" && typeof body["timestamp"] === "string";
  const [posture, card] = await Promise.all([
    nineHealth ? probeJson(`${origin}/api/settings/require-login`, signal) : Promise.resolve<Probe>({ kind: "http" }),
    omniHealth ? probeJson(`${origin}/.well-known/agent.json`, signal) : Promise.resolve<Probe>({ kind: "http" }),
  ]);
  const postureBody = posture.kind === "json" ? plainObject(posture.value) : null;
  const nine =
    nineHealth &&
    postureBody !== null &&
    typeof postureBody["requireLogin"] === "boolean" &&
    typeof postureBody["tunnelDashboardAccess"] === "boolean";
  const cardBody = card.kind === "json" ? plainObject(card.value) : null;
  const omni =
    omniHealth &&
    cardBody !== null &&
    asString(cardBody["name"]).trim() === "OmniRoute AI Gateway" &&
    plainObject(cardBody["capabilities"]) !== null &&
    Array.isArray(cardBody["skills"]);
  if (nine && omni) return "ambiguous";
  return nine ? "9router" : omni ? "omniroute" : "unknown";
};

export interface CatalogResult {
  readonly status: CatalogStatus;
  readonly httpStatus?: number;
  readonly models: readonly ProviderModelItem[];
  readonly partial: boolean;
}

const failed = (status: CatalogStatus, httpStatus?: number): CatalogResult => ({
  status,
  ...(httpStatus !== undefined ? { httpStatus } : {}),
  models: [],
  partial: false,
});

const statusOfHttp = (status: number): CatalogStatus => {
  if (status >= 300 && status < 400) return "redirect";
  if (status === 401) return "auth-required";
  if (status === 403) return "denied";
  if (status === 404) return "api-not-found";
  return "http-error";
};

const looksLikeHtml = (contentType: string, body: string): boolean =>
  /html/i.test(contentType) || /^\s*<(?:!doctype|html|head|body)/i.test(body);

/** Bounded `GET <apiBase>/models`: no redirects, size/row/page caps, exact IDs. Never throws. */
export const fetchCatalog = async (
  apiBase: string,
  apiKey: string,
  options: { readonly signal: AbortSignal; readonly timeoutMs: number },
): Promise<CatalogResult> => {
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const live: ReturnType<typeof extractLiveModelsFromPayload> = [];
  const seenCursors = new Set<string>();
  let after: string | null = null;
  let pages = 0;
  let rows = 0;
  let partial = false;
  const finish = (): CatalogResult => {
    const models = buildModelItems([], live, []);
    return { status: models.length === 0 ? (partial ? "partial" : "empty") : partial ? "partial" : "ok", models, partial };
  };
  for (;;) {
    const url: string = `${apiBase}/models${after === null ? "" : `?after=${encodeURIComponent(after)}`}`;
    const result = await boundedGet(url, {
      headers,
      timeoutMs: options.timeoutMs,
      maxBytes: DISCOVERY_LIMITS.catalogMaxBytes,
      signal: options.signal,
    });
    pages += 1;
    const first = pages === 1;
    if (result.kind !== "response" || result.status < 200 || result.status >= 300 || looksLikeHtml(result.contentType, result.body)) {
      if (!first && live.length > 0) {
        partial = true;
        return finish();
      }
      if (result.kind === "response") {
        return looksLikeHtml(result.contentType, result.body) && result.status < 300
          ? failed("api-not-found", result.status)
          : failed(statusOfHttp(result.status), result.status);
      }
      if (result.kind === "too-large") return failed("too-large", result.status);
      if (result.kind === "timeout") return failed("timeout");
      return failed("unreachable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.body) as unknown;
    } catch {
      if (!first && live.length > 0) {
        partial = true;
        return finish();
      }
      return failed("malformed", result.status);
    }
    const record = plainObject(parsed);
    const list = Array.isArray(parsed) ? parsed : record && Array.isArray(record["data"]) ? (record["data"] as unknown[]) : null;
    if (!list) {
      if (!first && live.length > 0) {
        partial = true;
        return finish();
      }
      return failed("malformed", result.status);
    }
    const remaining = DISCOVERY_LIMITS.catalogMaxRows - rows;
    const slice = list.slice(0, remaining);
    rows += slice.length;
    live.push(...extractLiveModelsFromPayload("router", { data: slice }, { kindAware: true }));
    if (list.length > remaining) {
      partial = true;
      return finish();
    }
    if (record?.["has_more"] !== true) return finish();
    const cursor = record["last_id"];
    if (typeof cursor !== "string" || cursor === "" || seenCursors.has(cursor) || pages >= DISCOVERY_LIMITS.catalogMaxPages) {
      partial = true;
      return finish();
    }
    seenCursors.add(cursor);
    after = cursor;
  }
};

export interface DiscoveredRouter {
  readonly product: RouterProduct;
  readonly origin: string;
  readonly apiBase: string;
  readonly catalog: CatalogResult;
}

export type CatalogCache = Map<string, { readonly at: number; readonly result: CatalogResult }>;

export interface DiscoverOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly candidates?: readonly RouterCandidate[];
  readonly onRouter?: (router: DiscoveredRouter) => void;
  /** Optional in-memory catalog cache, keyed by product|apiBase|keyId. */
  readonly cache?: CatalogCache;
  readonly force?: boolean;
  readonly now?: () => number;
}

const keyId = (key: string): string => (key ? createHash("sha256").update(key).digest("hex").slice(0, 16) : "-");

const routerKey = (product: RouterProduct, env: NodeJS.ProcessEnv): string => env[ROUTER_PRODUCTS[product].apiKeyEnv]?.trim() ?? "";

export const discoverLocalRouters = async (options: DiscoverOptions): Promise<readonly DiscoveredRouter[]> => {
  const { env, signal } = options;
  const candidates = options.candidates ?? routerCandidates(env);
  const now = options.now ?? Date.now;
  const identitySignal = AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_LIMITS.scanBudgetMs)]);
  const winners = new Map<RouterProduct, { readonly index: number; router: DiscoveredRouter }>();
  const emit = (router: DiscoveredRouter): void => {
    if (!signal.aborted) options.onRouter?.(router);
  };

  const catalogFor = async (product: RouterProduct, apiBase: string, ownKey: string | undefined): Promise<CatalogResult> => {
    const key = ownKey ?? routerKey(product, env);
    const cacheKey = `${product}|${apiBase}|${keyId(key)}`;
    const cached = options.cache?.get(cacheKey);
    if (cached && !options.force && now() - cached.at < DISCOVERY_LIMITS.catalogTtlMs) return cached.result;
    const result = await fetchCatalog(apiBase, key, { signal, timeoutMs: DISCOVERY_LIMITS.catalogTimeoutMs });
    if (!signal.aborted && (result.status === "ok" || result.status === "partial" || result.status === "empty")) {
      options.cache?.set(cacheKey, { at: now(), result });
    }
    return result;
  };

  const handle = async (candidate: RouterCandidate, index: number): Promise<void> => {
    let product: RouterProduct;
    if (candidate.explicit) {
      product = candidate.explicit;
    } else {
      const fingerprint = await identifyRouter(candidate.origin, identitySignal);
      if (fingerprint !== "9router" && fingerprint !== "omniroute") return;
      product = fingerprint;
    }
    const current = winners.get(product);
    if (current && current.index < index) return;
    const loading: DiscoveredRouter = {
      product,
      origin: candidate.origin,
      apiBase: candidate.apiBase,
      catalog: { status: "loading", models: [], partial: false },
    };
    winners.set(product, { index, router: loading });
    emit(loading);
    const catalog = await catalogFor(product, candidate.apiBase, candidate.apiKey);
    const latest = winners.get(product);
    if (signal.aborted || !latest || latest.index !== index) return;
    const done: DiscoveredRouter = { ...loading, catalog };
    latest.router = done;
    emit(done);
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (!signal.aborted) {
      const index = next;
      next += 1;
      const candidate = candidates[index];
      if (!candidate) return;
      await handle(candidate, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DISCOVERY_LIMITS.concurrency, candidates.length) }, worker));
  if (signal.aborted) return [];
  return PRODUCT_ORDER.flatMap((product) => {
    const winner = winners.get(product);
    return winner && winner.router.catalog.status !== "loading" ? [winner.router] : [];
  });
};

const catalogMessage = (status: CatalogStatus): string | null => (status === "ok" || status === "partial" || status === "empty" || status === "loading" ? null : status);

/** Provider row for a detected router. Its key comes only from that product's own environment variable. */
export const routerProvider = (router: DiscoveredRouter, id: string, env: NodeJS.ProcessEnv): ResolvedProvider => {
  const spec = ROUTER_PRODUCTS[router.product];
  const apiKey = routerKey(router.product, env);
  const loopback = (() => {
    try {
      return isLoopbackHost(new URL(router.origin).hostname);
    } catch {
      return false;
    }
  })();
  return {
    id,
    name: spec.name,
    protocol: "openai-chat",
    baseUrl: router.apiBase,
    connected: true,
    local: loopback,
    apiKey,
    apiKeyEnv: spec.apiKeyEnv,
    keySource: apiKey ? `env ${spec.apiKeyEnv}` : "local (no key)",
    envHint: spec.apiKeyEnv,
    headers: {},
    models: router.catalog.models,
    liveLoaded: router.catalog.status === "ok" || router.catalog.status === "partial" || router.catalog.status === "empty",
    error: catalogMessage(router.catalog.status),
    provenance: "detected",
    product: router.product,
    catalogStatus: router.catalog.status,
    ...(router.catalog.httpStatus !== undefined ? { httpStatus: router.catalog.httpStatus } : {}),
  };
};

