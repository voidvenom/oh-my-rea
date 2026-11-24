import { VERSION } from "./version.js";

export interface BoundedGetOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export type BoundedGetResult =
  | { readonly kind: "response"; readonly status: number; readonly contentType: string; readonly body: string }
  | { readonly kind: "too-large"; readonly status: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" }
  | { readonly kind: "unreachable"; readonly code: string };

const errorCode = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return "fetch-failed";
  const cause = (error as { cause?: unknown }).cause;
  const code =
    typeof cause === "object" && cause !== null
      ? (cause as { code?: unknown }).code
      : (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : "fetch-failed";
};

/**
 * GET without redirects, cookies, proxy configuration or retries; never throws.
 * A 3xx answer is returned as a response with its status; `Location` is never read.
 */
export const boundedGet = async (url: string, options: BoundedGetOptions): Promise<BoundedGetResult> => {
  const caller = options.signal;
  if (caller?.aborted) return { kind: "aborted" };
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
  try {
    const response = await globalThis.fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: { accept: "application/json", "user-agent": `omr/${VERSION}`, ...options.headers },
      signal,
    });
    const status = response.status;
    const contentType = response.headers.get("content-type") ?? "";
    if (status >= 300 && status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "response", status, contentType, body: "" };
    }
    const reader = response.body?.getReader();
    if (!reader) return { kind: "response", status, contentType, body: "" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too-large", status };
      }
      chunks.push(next.value);
    }
    const body = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
    return { kind: "response", status, contentType, body };
  } catch (error) {
    if (caller?.aborted) return { kind: "aborted" };
    if (timeout.aborted) return { kind: "timeout" };
    return { kind: "unreachable", code: errorCode(error) };
  }
};
