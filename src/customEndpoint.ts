/** Pure validation helpers for user-typed endpoints. No I/O; only types are imported from other omr modules. */
import type { CatalogStatus } from "./providers.js";

export type UrlRejectReason = "empty" | "scheme" | "invalid" | "credentials" | "query" | "host" | "too-long";

export interface ValidatedBaseUrl {
  readonly baseUrl: string;
  readonly origin: string;
  readonly loopback: boolean;
  readonly secure: boolean;
  readonly originOnly: boolean;
}

export type BaseUrlValidation =
  | { readonly ok: true; readonly value: ValidatedBaseUrl }
  | { readonly ok: false; readonly reason: UrlRejectReason; readonly host?: string };

const MAX_URL_LENGTH = 2048;
const MAX_KEY_LENGTH = 4096;
// C0/C1/DEL controls, bidi controls and any whitespace.
// eslint-disable-next-line no-control-regex
const UNSAFE_URL_CHARS = /[\u0000- \u007f-\u009f‪-‮⁦-⁩\s]/;

export const isLoopbackHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
};

const isUnusableHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  if (host === "0.0.0.0" || host === "[::]" || host === "255.255.255.255") return true;
  if (host.startsWith("[ff")) return true;
  const first = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(host);
  return Boolean(first && Number(first[1]) >= 224 && Number(first[1]) <= 239);
};

const stripApiSuffix = (path: string): string => path.replace(/\/+$/, "").replace(/\/(?:chat\/completions|models)$/i, "");

export const validateCustomBaseUrl = (raw: string): BaseUrlValidation => {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > MAX_URL_LENGTH) return { ok: false, reason: "too-long" };
  if (UNSAFE_URL_CHARS.test(text)) return { ok: false, reason: "invalid" };
  let candidate = text;
  if (!text.includes("://")) {
    const hostPart = text.split("/")[0] ?? "";
    if (/^[^/]*:\d+$/.test(hostPart) || !/^[a-z][a-z0-9+.-]*:/i.test(text)) {
      const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(hostPart);
      candidate = `${local ? "http" : "https"}://${text}`;
    } else {
      return { ok: false, reason: "scheme" };
    }
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (candidate.includes("?") || candidate.includes("#")) return { ok: false, reason: "query" };
  if (!url.hostname) return { ok: false, reason: "invalid" };
  if (isUnusableHost(url.hostname)) return { ok: false, reason: "host", host: url.hostname };
  const path = stripApiSuffix(url.pathname);
  return {
    ok: true,
    value: {
      baseUrl: `${url.protocol}//${url.host}${path}`,
      origin: url.origin,
      loopback: isLoopbackHost(url.hostname),
      secure: url.protocol === "https:",
      originOnly: path === "",
    },
  };
};

export type KeyInput =
  | { readonly kind: "none" }
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "env"; readonly name: string };

export const parseKeyInput = (raw: string): { readonly ok: true; readonly value: KeyInput } | { readonly ok: false } => {
  const text = raw.trim();
  if (!text) return { ok: true, value: { kind: "none" } };
  const env =
    /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text) ??
    /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(text) ??
    /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
  if (env?.[1]) return { ok: true, value: { kind: "env", name: env[1] } };
  if (text.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(text)) return { ok: false };
  return { ok: true, value: { kind: "literal", value: text } };
};

/** keySource of a typed literal key; the picker uses it to ask before writing the key to disk. */
export const SESSION_KEY_SOURCE = "session key";

export const customProviderId = (value: ValidatedBaseUrl, taken: ReadonlySet<string>): string => {
  let host = "endpoint";
  let port = "";
  try {
    const url = new URL(value.origin);
    host = url.hostname.startsWith("[") ? `ipv6-${url.hostname}` : url.hostname;
    port = url.port;
  } catch {
    // value.origin is canonical; fall through with the generic slug.
  }
  const slug = host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "endpoint";
  const base = `custom-${slug}${port ? `-${port}` : ""}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const next = `${base}-${n}`;
    if (!taken.has(next)) return next;
  }
};

const endpointKey = (raw: string): string | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const equivalent = host === "localhost" || host === "127.0.0.1" || host === "[::1]" ? "loopback" : host;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.protocol}//${equivalent}:${port}${stripApiSuffix(url.pathname)}`;
};

/** Loopback-equivalent (localhost, 127.0.0.1, [::1]) comparison of scheme, port and path; host is case-insensitive. */
export const sameEndpoint = (a: string, b: string): boolean => {
  const left = endpointKey(a);
  const right = endpointKey(b);
  return left !== null && right !== null && left === right;
};

/** What the picker's Custom provider wizard asks the controller to test. */
export interface CustomEndpointRequest {
  readonly rawUrl: string;
  readonly key: KeyInput;
  /** Set when the wizard was opened from a router that answered 401/403: the key goes to that provider. */
  readonly targetProviderId: string | null;
}

export type CustomEndpointTestResult =
  | { readonly status: "ok" | "partial" | "empty"; readonly providerId: string; readonly origin: string; readonly modelCount: number }
  | {
      readonly status: Exclude<CatalogStatus, "ok" | "partial" | "empty" | "loading" | "offline"> | "invalid-url" | "env-missing" | "aborted";
      readonly httpStatus?: number;
      readonly origin?: string;
    };
