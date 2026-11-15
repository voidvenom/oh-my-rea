import { isDeepStrictEqual } from "node:util";
import { ConcurrencyLimiter } from "./concurrency.js";
import { retainedEvidence } from "./evidence.js";
import type { ForgeRegistry } from "./forge.js";
import { selectJsonPointer } from "./jsonPointer.js";
import type { ProgressTracker } from "./progress.js";
import type { RecipeEngine } from "./recipes.js";
import type { ReaPort } from "./rea.js";
import type { TaskEntry, TaskStateStore, TaskVerification } from "./taskState.js";
import { asRecord, asString } from "./values.js";

interface Proof {
  readonly valid: boolean;
  readonly kind: string;
  readonly value?: unknown;
  readonly reason: string;
}
export interface CoverageDependencies {
  readonly task: TaskStateStore;
  readonly forge: ForgeRegistry;
  readonly recipes: RecipeEngine;
  readonly progress: ProgressTracker;
  readonly rea: () => ReaPort | null;
  readonly binding: () => unknown;
  readonly origin: () => unknown;
  readonly signal: AbortSignal;
  readonly initialize: () => Promise<void>;
  readonly withLease: <T>(work: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
}
export interface CoverageOptions { readonly itemId?: string; readonly offset?: number; readonly limit?: number; }
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const brief = (value: unknown): string => { const text = JSON.stringify(value) ?? "undefined"; return text.length > 1000 ? `${text.slice(0,1000)} [preview truncated]` : text; };

/** Distinguishes inspected references, verified declared predicates and residual/provider Unknowns. */
export class CoverageService {
  constructor(private readonly deps: CoverageDependencies) {}
  async report(options: CoverageOptions = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal = signal ? AbortSignal.any([signal, this.deps.signal]) : this.deps.signal;
    const offset = options.offset ?? 0, limit = options.limit ?? 20;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Coverage offset must be non-negative and limit must be 1–100");
    await this.deps.initialize();
    return this.deps.withLease(async () => {
      signal!.throwIfAborted();
      const state = await this.deps.task.read(); const rea = this.deps.rea();
      const all = options.itemId ? state.acceptance.filter(entry => entry.id === options.itemId) : state.acceptance;
      if (options.itemId && !all.length) throw new Error(`Unknown acceptance item: ${options.itemId}`);
      const page = all.slice(offset, offset + limit);
      const limiter = new ConcurrencyLimiter(4); const proofs = new Map<string, Promise<Proof>>();
      const resolve = (ref: string): Promise<Proof> => {
        const cached = proofs.get(ref); if (cached) return cached;
        if (proofs.size >= 200) return Promise.resolve({ valid: false, kind: "unassessed", reason: "Proof lookup limit reached; request one item or a smaller page" });
        const promise = limiter.run(async (): Promise<Proof> => {
          signal!.throwIfAborted();
          try {
            if (/^ev_[a-f0-9]{64}$/.test(ref)) {
              const record = rea ? await retainedEvidence(rea, ref, signal) : null;
              return { valid: record !== null, kind: "evidence", value: record, reason: record ? "Exact record retained by the active REA ledger" : "Evidence is not retained or REA is unavailable" };
            }
            if (ref.startsWith("forge:")) { const valid = await this.deps.forge.resolveProof(ref); return { valid, kind: "forge-fixtures", reason: valid ? "Source, environment and exact semantic fixtures match" : "Fixture proof is absent, retired or changed" }; }
            if (/^recipe:[a-f0-9-]{36}$/.test(ref)) { const valid = await this.deps.recipes.resolveProof(ref.slice(7)); return { valid, kind: "recipe-exit", reason: valid ? "Recipe implementation, exit conditions, artifacts and native Evidence match" : "Recipe proof or active-ledger Evidence is unavailable or changed" }; }
            if (/^unk_[a-f0-9]{64}$/.test(ref)) {
              if (!rea?.find("verify_unknown_resolution")) return { valid: false, kind: "unknown-resolution", reason: "Native Unknown verification is unavailable" };
              const result = await rea.call("verify_unknown_resolution", { unknown_id: ref }, { signal });
              const verdict = asRecord(result.payload); const unknown = asRecord(verdict?.["unknown"]);
              const valid = !result.isError && verdict?.["valid"] === true && verdict["truthVerified"] === true && unknown?.["unknown_id"] === ref && unknown["status"] === "resolved" && asRecord(unknown["resolution"])?.["disposition"] === "verified";
              return { valid, kind: "unknown-resolution", reason: valid ? "Backend truth-verified the current Unknown resolution" : "Unknown is open, unverified, withdrawn or out of scope" };
            }
            return { valid: false, kind: "reference", reason: "Reference is not an executable verification proof" };
          } catch (error) { if (signal!.aborted) throw error; return { valid: false, kind: "unavailable", reason: message(error) }; }
        }, signal);
        proofs.set(ref, promise); return promise;
      };
      const verify = async (check: TaskVerification | undefined): Promise<Record<string, unknown>> => {
        if (!check) return { passed: false, reason: "No machine criterion declared; a claim or reference alone is insufficient" };
        const proof = await resolve(check.ref); let passed = false, reason = proof.reason; let actual: unknown;
        if (check.kind === "evidence-equals" && proof.valid && proof.kind === "evidence") {
          const selected = selectJsonPointer(proof.value, check.pointer); actual = selected.value;
          passed = selected.found && isDeepStrictEqual(selected.value, check.equals); reason = !selected.found ? "JSON pointer does not exist in the retained record" : passed ? "Retained record matches the declared JSON predicate" : "Retained value differs from the declared expected JSON";
        } else passed = proof.valid && proof.kind === check.kind;
        return { kind: check.kind, ref: check.ref, ...(check.kind === "evidence-equals" ? { pointer: check.pointer, expectedPreview: brief(check.equals), actualPreview: brief(actual) } : {}), passed, reason };
      };
      const items = await Promise.all(page.map(async (entry: TaskEntry) => {
        const verification = await verify(entry.verification);
        const refs = [...new Set([...(entry.verification ? [entry.verification.ref] : []), ...entry.proofRefs.slice(0,10)])];
        const inspected = await Promise.all(refs.map(async ref => { const proof = await resolve(ref); return { ref, valid: proof.valid, kind: proof.kind, reason: proof.reason }; }));
        const assessment = entry.status === "blocked" ? "blocked" : verification["passed"] === true ? "verified" : inspected.some(proof => proof.valid) ? "inspected" : "unverified";
        return { id: entry.id, text: entry.text.length > 1000 ? `${entry.text.slice(0,1000)} [preview truncated]` : entry.text, declaredStatus: entry.status, assessment, verification, proofRefs: inspected, totalProofRefs: entry.proofRefs.length, proofRefsOmitted: entry.proofRefs.length > 10 };
      }));
      const statuses = ["open", "investigating", "blocked", "contradicted", "resolved"] as const;
      const unknowns = await Promise.all(statuses.map(async status => {
        try {
          if (!rea?.find("list_unknowns")) return { status, total: null, sample: [], available: false, reason: "Native Unknown registry is unavailable" };
          const result = await rea.call("list_unknowns", { status, limit: 10 }, { signal }); const value = asRecord(result.payload);
          if (result.isError || !Number.isSafeInteger(value?.["total"]) || Number(value?.["total"]) < 0 || !Array.isArray(value?.["items"])) return { status, total: null, sample: [], available: false, reason: result.text || "Malformed Unknown response" };
          const sample = value["items"].map(raw => { const item = asRecord(raw); return { id: item?.["unknown_id"] ?? null, revision: item?.["revision"] ?? null, question: asString(item?.["question"]).slice(0,300), disposition: asRecord(item?.["resolution"])?.["disposition"] ?? null }; });
          return { status, total: Number(value["total"]), sample, nextOffset: value["next_offset"] ?? null, available: true };
        } catch (error) { if (signal!.aborted) throw error; return { status, total: null, sample: [], available: false, reason: message(error) }; }
      }));
      let ledger: unknown = { available: false, totalRetainedRecords: null };
      try {
        if (rea?.find("get_evidence_bundle")) { const result = await rea.call("get_evidence_bundle", { detail: "summary" }, { signal }); const total = asRecord(result.payload)?.["total_retained_records"]; ledger = { available: !result.isError && Number.isSafeInteger(total), totalRetainedRecords: !result.isError && Number.isSafeInteger(total) ? total : null }; }
      } catch (error) { if (signal!.aborted) throw error; ledger = { available: false, totalRetainedRecords: null, reason: message(error) }; }
      const recent = await this.deps.recipes.recent();
      const providerCoverage = await Promise.all(recent.slice(0,5).map(async raw => { const item = asRecord(raw)!; const run = await this.deps.recipes.inspect(String(item["id"])); return { runId: run.id, recipe: run.recipe, status: run.status, originSessionId: run.originSessionId, binding: run.binding, coverage: run.coverage }; }));
      const latestRevision = (await this.deps.task.read()).revision; const fullAssessment = !options.itemId && offset === 0 && items.length === state.acceptance.length;
      const goalStatus = latestRevision !== state.revision ? "stale_assessment" : !state.acceptance.length ? "unmeasured" : !fullAssessment ? "partially_assessed" : items.every(item => item.assessment === "verified") ? "acceptance_conditions_met" : "in_progress";
      const open = unknowns.filter(item => item.status !== "resolved");
      return { schema: "omr-coverage/v1", observedAt: new Date().toISOString(), taskRevision: state.revision, latestTaskRevision: latestRevision, binding: this.deps.binding(), origin: this.deps.origin(), assessmentScope: "Declared machine criteria at recorded proof references; prose goals/constraints and unobserved behavior are not certified", goalPreview: state.goal.slice(0,2000), goalStatus,
        acceptance: { total: state.acceptance.length, selectedTotal: all.length, offset, limit, nextOffset: offset + limit < all.length ? offset + limit : null, items },
        ledger, unknowns: { openTotal: open.every(item => item.available) ? open.reduce((sum, item) => sum + (item.total ?? 0), 0) : null, statuses: unknowns, atomicSnapshot: false }, providerCoverage,
        progress: this.deps.progress.snapshot(), proofLookups: proofs.size };
    }, signal);
  }
}
