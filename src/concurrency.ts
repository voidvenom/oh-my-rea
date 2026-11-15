import { AsyncLocalStorage } from "node:async_hooks";

/** Wait without retaining an abort listener after either branch settles. */
export const abortable = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { cleanup(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
};

/** One wall-clock deadline can cover discovery, HTTP headers, and response bodies. */
export const deadlineSignal = (timeoutMs: number, parent?: AbortSignal): {signal: AbortSignal; dispose: () => void} => {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, {once: true});
  const timer = setTimeout(() => controller.abort(new DOMException(`Operation timed out after ${timeoutMs}ms`, "TimeoutError")), timeoutMs);
  timer.unref?.();
  return {signal: controller.signal, dispose: () => {clearTimeout(timer); parent?.removeEventListener("abort", onAbort);}};
};

/** FIFO permits are transferred before waking a waiter; cancellation never consumes capacity. */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<{ grant: () => void }> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Concurrency limit must be a positive integer");
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) { this.active += 1; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const waiter = { grant: (): void => { signal?.removeEventListener("abort", onAbort); resolve(); } };
      this.queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try { signal?.throwIfAborted(); return await fn(); }
    finally {
      const next = this.queue.shift();
      if (next) next.grant();
      else this.active -= 1;
    }
  }
}


/** Writer-fair target leases; nested calls in the same async task reuse their lease. */
export class TargetCoordinator {
  private readers = 0;
  private writer = false;
  private readonly scope = new AsyncLocalStorage<"read" | "write">();
  private readonly queue: Array<{mode: "read" | "write"; grant: () => void}> = [];

  private drain(): void {
    if (this.writer) return;
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      if (next.mode === "write") {
        if (this.readers > 0) return;
        this.queue.shift(); this.writer = true; next.grant(); return;
      }
      this.queue.shift(); this.readers += 1; next.grant();
    }
  }

  private acquire(mode: "read" | "write", signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        this.drain();
      };
      const waiter = { mode, grant: (): void => {signal?.removeEventListener("abort", onAbort); resolve();} };
      this.queue.push(waiter);
      signal?.addEventListener("abort", onAbort, {once: true});
      this.drain();
    });
  }

  async run<T>(mode: "read" | "write", work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const held = this.scope.getStore();
    if (held === "write" || held === mode) return work();
    if (held === "read") throw new Error("A worker target read lease cannot be upgraded to a mutation");
    await this.acquire(mode, signal);
    try { signal?.throwIfAborted(); return await this.scope.run(mode, work); }
    finally {
      if (mode === "read") this.readers -= 1; else this.writer = false;
      this.drain();
    }
  }
}
