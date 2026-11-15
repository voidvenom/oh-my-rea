/** Process-wide admission at physical backend boundaries, shared by all sessions and workers. */
export const DEFAULT_RESOURCE_LIMITS = Object.freeze({ model: 4, rea: 2, browser: 4, script: 2, shell: 2, mcpProcess: 2, browserProcess: 2 });
export type ResourceKind = keyof typeof DEFAULT_RESOURCE_LIMITS;
export type ResourceLimits = Record<ResourceKind, number>;
export interface ResourceSnapshot { readonly limit: number; readonly active: number; readonly queued: number; readonly peak: number; readonly admitted: number; readonly cancelled: number; readonly waitMs: number; }
type Waiter = { grant: () => void };
type Pool = { limit: number; active: number; queue: Waiter[]; peak: number; admitted: number; cancelled: number; waitMs: number };
const kinds = Object.keys(DEFAULT_RESOURCE_LIMITS) as ResourceKind[];

export class ResourceCapacityError extends Error {
  constructor(readonly resource: ResourceKind) { super(`Resource queue is full: ${resource}`); this.name = "ResourceCapacityError"; }
}

export class ResourceScheduler {
  private readonly pools = new Map<ResourceKind, Pool>();
  constructor(limits: Partial<ResourceLimits> = {}, readonly maxQueued = 128) {
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 1 || maxQueued > 4096) throw new Error("Resource maxQueued must be 1–4096");
    this.configure(limits);
  }
  /** Atomic reconfiguration is allowed only while idle; no running lease changes its meaning. */
  configure(limits: Partial<ResourceLimits>): void {
    if (!limits || typeof limits !== "object" || Array.isArray(limits)) throw new Error("Resource limits must be an object");
    for (const [key, value] of Object.entries(limits)) if (!kinds.includes(key as ResourceKind) || !Number.isSafeInteger(value) || value < 1 || value > 256) throw new Error(`Invalid resource limit: ${key} (expected 1–256)`);
    if ([...this.pools.values()].some(pool => pool.active || pool.queue.length)) throw new Error("Cannot reconfigure resources while leases or queued requests exist");
    for (const kind of kinds) { const previous = this.pools.get(kind); this.pools.set(kind, { limit: limits[kind] ?? previous?.limit ?? DEFAULT_RESOURCE_LIMITS[kind], active: 0, queue: [], peak: previous?.peak ?? 0, admitted: previous?.admitted ?? 0, cancelled: previous?.cancelled ?? 0, waitMs: previous?.waitMs ?? 0 }); }
  }
  snapshot(): Readonly<Record<ResourceKind, ResourceSnapshot>> {
    return Object.fromEntries(kinds.map(kind => { const pool = this.pools.get(kind)!; return [kind, { limit: pool.limit, active: pool.active, queued: pool.queue.length, peak: pool.peak, admitted: pool.admitted, cancelled: pool.cancelled, waitMs: pool.waitMs }]; })) as Record<ResourceKind, ResourceSnapshot>;
  }
  async acquire(kind: ResourceKind, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted(); const pool = this.pools.get(kind)!; const start = performance.now();
    if (pool.active < pool.limit) pool.active++;
    else {
      if (pool.queue.length >= this.maxQueued) throw new ResourceCapacityError(kind);
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => { const index = pool.queue.indexOf(waiter); if (index >= 0) { pool.queue.splice(index, 1); pool.cancelled++; } signal?.removeEventListener("abort", onAbort); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
        const waiter = { grant: (): void => { signal?.removeEventListener("abort", onAbort); resolve(); } };
        pool.queue.push(waiter); signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    pool.peak = Math.max(pool.peak, pool.active); pool.admitted++; pool.waitMs += performance.now() - start;
    let released = false;
    const release = (): void => { if (released) return; released = true; const next = pool.queue.shift(); if (next) next.grant(); else pool.active--; };
    try { signal?.throwIfAborted(); } catch (error) { release(); throw error; }
    return release;
  }
  async run<T>(kind: ResourceKind, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(kind, signal); try { signal?.throwIfAborted(); return await work(); } finally { release(); }
  }
}

const configured = process.env["OMR_RESOURCE_LIMITS"];
export const resources = new ResourceScheduler(configured ? JSON.parse(configured) as Partial<ResourceLimits> : {});
export const configureResourceLimits = (limits: Partial<ResourceLimits>): void => resources.configure(limits);
