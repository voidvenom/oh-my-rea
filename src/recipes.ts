import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConcurrencyLimiter } from "./concurrency.js";
import { writeJsonAtomic } from "./durable.js";
import { verifyReturnedEvidence, type RetainedEvidence } from "./evidence.js";
import type { ExecutionStore } from "./execution.js";
import { OUTCOME_PRIORITY, type ExecutionStatus } from "./outcome.js";
import type { ReaPort } from "./rea.js";
import { asRecord, asString } from "./values.js";

const sha = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const implementationSha256 = sha(readFileSync(fileURLToPath(import.meta.url)));
export const ANALYSIS_RECIPES = [
  { id: "javascript", version: "1.0.0", description: "Retain a local static JavaScript analysis and its explicit coverage", requiredTools: ["analyze_javascript_application", "get_evidence_bundle"], entry: ["absolute input_path"], exit: ["analysis Evidence is retained in the active ledger", "at least one JavaScript source was parsed"], steps: ["analysis"], exitIds: ["javascript-parsed", "native-evidence-retained"] },
  { id: "browser-javascript", version: "1.0.0", description: "Link passive CDP DOM/network, a verified screenshot, exported source bytes and static JavaScript Evidence", requiredTools: ["inspect_web_page", "capture_web_screenshot", "export_web_scripts", "analyze_javascript_application", "get_evidence_bundle"], entry: ["live cdp_endpoint (or owned local browser)", "explicit target_id"], exit: ["DOM and bounded network observation are retained", "screenshot bytes match digest", "exported source bytes match manifest", "static analysis Evidence is retained"], steps: ["capture", "screenshot", "export", "analysis"], exitIds: ["dom-recorded", "network-minimum", "screenshot-integrity", "export-path", "export-manifest-integrity", "scripts-exported", "javascript-parsed", "native-evidence-retained"] },
] as const;
type RecipeId = typeof ANALYSIS_RECIPES[number]["id"];
interface RecipeStep { readonly id: string; readonly tool: string; readonly args: Record<string, unknown>; readonly evidenceId: string; readonly resultPath: string; }
interface RecipeArtifact { readonly kind: string; readonly path: string; readonly sha256: string; readonly bytes: number; }
interface ExitCondition { readonly id: string; readonly passed: boolean; readonly detail: unknown; }
export interface RecipeRun {
  readonly schema: 1;
  readonly id: string;
  readonly recipe: RecipeId;
  readonly version: string;
  readonly recipeSha256: string;
  readonly implementationSha256: string;
  readonly input: Record<string, unknown>;
  readonly binding: unknown;
  readonly originSessionId: string;
  readonly startedAt: string;
  status: ExecutionStatus | "running";
  finishedAt: string | null;
  problem: string | null;
  readonly steps: RecipeStep[];
  readonly artifacts: RecipeArtifact[];
  readonly exitConditions: ExitCondition[];
  readonly coverage: Record<string, unknown>;
}
export interface RecipeDependencies {
  readonly sessionId: string;
  readonly directory: string;
  readonly trace: ExecutionStore;
  readonly rea: () => ReaPort | null;
  readonly binding: () => unknown;
  readonly activeCdpEndpoint: () => string | null;
  readonly assertRecoveryReady: () => Promise<void>;
  readonly signal: AbortSignal;
  readonly withLease: <T>(work: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
}
const numeric = (value: unknown, fallback: number, max: number, label: string): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new Error(`${label} must be an integer from 0 to ${max}`);
  return Number(value);
};
const runId = (value: string): string => { if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error("Invalid recipe run ID"); return value; };

/** Small deterministic analysis recipes; model playbooks remain a separate capability. */
export class RecipeEngine {
  private readonly running = new ConcurrencyLimiter(1);
  readonly directory: string;
  constructor(private readonly deps: RecipeDependencies) { this.directory = join(deps.directory, "recipes"); }
  list(): unknown[] { return ANALYSIS_RECIPES.map(recipe => ({ ...recipe, recipeSha256: sha(JSON.stringify(recipe)), implementationSha256 })); }
  private path(id: string): string { return join(this.directory, runId(id), "run.json"); }
  async inspect(id: string): Promise<RecipeRun> {
    const path = this.path(id); if ((await stat(path)).size > 4_194_304) throw new Error("Recipe record exceeds 4 MiB");
    const value = asRecord(JSON.parse(await readFile(path, "utf8")));
    if (value?.["schema"] !== 1 || value["id"] !== id || !ANALYSIS_RECIPES.some(recipe => recipe.id === value["recipe"]) || typeof value["version"] !== "string" || ["recipeSha256", "implementationSha256"].some(key => !/^[a-f0-9]{64}$/.test(asString(value[key]))) || !asString(value["originSessionId"]) || !asRecord(value["input"]) || !asRecord(value["coverage"]) || !Number.isFinite(Date.parse(asString(value["startedAt"]))) || ![...OUTCOME_PRIORITY, "running"].includes(asString(value["status"])) || (value["problem"] !== null && typeof value["problem"] !== "string") || (value["status"] === "running" ? value["finishedAt"] !== null : !Number.isFinite(Date.parse(asString(value["finishedAt"])))) || !Array.isArray(value["steps"]) || !Array.isArray(value["artifacts"]) || !Array.isArray(value["exitConditions"])) throw new Error("Invalid recipe run record");
    if (value["steps"].some(raw => { const step = asRecord(raw); return !step || !asString(step["id"]) || !asString(step["tool"]) || !asRecord(step["args"]) || !/^ev_[a-f0-9]{64}$/.test(asString(step["evidenceId"])) || !asString(step["resultPath"]); }) || value["artifacts"].some(raw => { const artifact = asRecord(raw); return !artifact || !asString(artifact["kind"]) || !asString(artifact["path"]) || !/^[a-f0-9]{64}$/.test(asString(artifact["sha256"])) || !Number.isSafeInteger(artifact["bytes"]) || Number(artifact["bytes"]) < 0; }) || value["exitConditions"].some(raw => { const condition = asRecord(raw); return !condition || !asString(condition["id"]) || typeof condition["passed"] !== "boolean"; })) throw new Error("Invalid recipe step, artifact or condition");
    return value as unknown as RecipeRun;
  }
  async recent(): Promise<unknown[]> {
    let ids: string[]; try { ids = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const runs: RecipeRun[] = [];
    for (const id of ids.filter(id => /^[a-f0-9-]{36}$/.test(id))) runs.push(await this.inspect(id));
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 25).map(run => ({ id: run.id, recipe: run.recipe, status: run.status, binding: run.binding, originSessionId: run.originSessionId, startedAt: run.startedAt }));
  }
  async resolveProof(id: string): Promise<boolean> {
    let run: RecipeRun; try { run = await this.inspect(id); } catch { return false; }
    const recipe = ANALYSIS_RECIPES.find(recipe => recipe.id === run.recipe);
    if (!recipe || run.version !== recipe.version || run.recipeSha256 !== sha(JSON.stringify(recipe)) || run.implementationSha256 !== implementationSha256 || run.status !== "completed" || run.exitConditions.length !== recipe.exitIds.length || run.exitConditions.some((condition, index) => condition.passed !== true || condition.id !== recipe.exitIds[index]) || run.steps.length !== recipe.steps.length || run.steps.some((step, index) => step.id !== recipe.steps[index])) return false;
    try {
      const root = await realpath(join(this.directory, id));
      for (const artifact of run.artifacts) { const rel = relative(root, await realpath(artifact.path)); if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false; const bytes = await this.readArtifact(artifact.path); if (bytes.length !== artifact.bytes || sha(bytes) !== artifact.sha256) return false; }
      const rea = this.deps.rea(); if (!rea) return false;
      const outputs = new Map<string, RetainedEvidence>();
      for (const step of run.steps) {
        if (!run.artifacts.some(artifact => artifact.kind === step.id && artifact.path === step.resultPath)) return false;
        const expected = ({ capture: "inspect_web_page", screenshot: "capture_web_screenshot", export: "export_web_scripts", analysis: "analyze_javascript_application" } as Record<string,string>)[step.id];
        if (step.tool !== expected) return false;
        const evidence = await verifyReturnedEvidence(rea, { isError: false, text: "", payload: JSON.parse(await readFile(step.resultPath, "utf8")), durationMs: 0 }, step.tool);
        if (evidence.evidence_id !== step.evidenceId) return false; outputs.set(step.id, evidence);
      }
      const analysis = asRecord(outputs.get("analysis")?.normalized_result); const summary = asRecord(analysis?.["summary"]) ?? analysis;
      if (Number(asRecord(summary?.["statistics"])?.["parsed_javascript_files"] ?? 0) <= 0 || summary?.["input_path"] !== run.steps.find(step => step.id === "analysis")?.args["input_path"]) return false;
      if (run.recipe === "browser-javascript") {
        const capture = asRecord(outputs.get("capture")?.normalized_result); const requests = asRecord(capture?.["network"])?.["requests"];
        if (!asRecord(capture?.["dom"]) || !Array.isArray(requests) || requests.length < Number(run.input["min_network_requests"])) return false;
        const image = asRecord(asRecord(outputs.get("screenshot")?.normalized_result)?.["artifact"]);
        if (!run.artifacts.some(artifact => artifact.kind === "screenshot-png" && artifact.sha256 === image?.["sha256"] && artifact.bytes === image?.["bytes"])) return false;
        if (!run.artifacts.some(artifact => artifact.kind === "export-manifest") || !run.artifacts.some(artifact => artifact.kind === "javascript-source")) return false;
      }
      return true;
    } catch { return false; }
  }
  private async readArtifact(path: string): Promise<Buffer> { if ((await stat(path)).size > 33_554_432) throw new Error("Recipe artifact exceeds 32 MiB"); return readFile(path); }
  async run(id: string, raw: unknown, signal?: AbortSignal): Promise<RecipeRun> {
    signal = signal ? AbortSignal.any([signal, this.deps.signal]) : this.deps.signal;
    const recipe = ANALYSIS_RECIPES.find(recipe => recipe.id === id); if (!recipe) throw new Error(`Unknown recipe: ${id}`);
    const input = asRecord(raw); if (!input || Array.isArray(input)) throw new Error("Recipe input must be an object");
    const allowed = recipe.id === "javascript" ? ["input_path", "analysis_timeout_ms", "max_heap_mb"] : ["cdp_endpoint", "target_id", "observation_ms", "min_network_requests", "analysis_timeout_ms", "max_heap_mb"];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error("Unknown recipe input field");
    const args = structuredClone(input);
    if (recipe.id === "javascript") { if (!asString(args["input_path"]) || !isAbsolute(asString(args["input_path"]))) throw new Error("javascript recipe requires an absolute input_path"); }
    else {
      args["cdp_endpoint"] ??= this.deps.activeCdpEndpoint();
      if (!asString(args["cdp_endpoint"]) || !asString(args["target_id"])) throw new Error("browser-javascript requires cdp_endpoint and target_id; discover targets with list_browser_targets first");
      args["observation_ms"] = numeric(args["observation_ms"], 500, 30_000, "observation_ms");
      args["min_network_requests"] = numeric(args["min_network_requests"], 0, 100_000, "min_network_requests");
    }
    args["analysis_timeout_ms"] = numeric(args["analysis_timeout_ms"], 30_000, 300_000, "analysis_timeout_ms");
    args["max_heap_mb"] = numeric(args["max_heap_mb"], 256, 2048, "max_heap_mb");
    if (Number(args["analysis_timeout_ms"]) < 1 || Number(args["max_heap_mb"]) < 128) throw new Error("Recipe analysis_timeout_ms must be positive and max_heap_mb must be at least 128");
    return this.running.run(async () => {
      signal?.throwIfAborted(); await this.deps.assertRecoveryReady();
      const rea = this.deps.rea(); if (!rea) throw new Error("Recipe requires an active REA connection");
      const missing = recipe.requiredTools.filter(name => !rea.find(name)); if (missing.length) throw new Error(`Recipe entry condition failed; missing tools: ${missing.join(", ")}`);
      const binding = structuredClone(this.deps.binding()); const run: RecipeRun = { schema: 1, id: randomUUID(), recipe: recipe.id, version: recipe.version, recipeSha256: sha(JSON.stringify(recipe)), implementationSha256, input: args, binding, originSessionId: this.deps.sessionId, startedAt: new Date().toISOString(), status: "running", finishedAt: null, problem: null, steps: [], artifacts: [], exitConditions: [], coverage: {} };
      const directory = join(this.directory, run.id); await mkdir(directory, { recursive: true, mode: 0o700 });
      const persist = () => writeJsonAtomic(this.path(run.id), run); await persist();
      await this.deps.trace.append("recipe.started", { id: run.id, recipe: run.recipe, version: run.version, recipeSha256: run.recipeSha256, input: args, binding });
      const artifact = async (kind: string, path: string): Promise<void> => { const bytes = await this.readArtifact(path); run.artifacts.push({ kind, path, sha256: sha(bytes), bytes: bytes.length }); };
      const condition = (id: string, passed: boolean, detail: unknown): void => { run.exitConditions.push({ id, passed, detail }); if (!passed) throw new Error(`Recipe exit condition failed: ${id}`); };
      const step = async (id: string, tool: string, parameters: Record<string, unknown>): Promise<RetainedEvidence> => {
        signal?.throwIfAborted();
        if (JSON.stringify(this.deps.binding()) !== JSON.stringify(binding)) throw new Error("Recipe target/session binding changed");
        const result = await rea.call(tool, parameters, { signal }); const resultPath = join(directory, `${id}.json`); await writeJsonAtomic(resultPath, result.payload);
        await artifact(id, resultPath);
        const evidence = await verifyReturnedEvidence(rea, result, tool, signal);
        run.steps.push({ id, tool, args: parameters, evidenceId: evidence.evidence_id, resultPath });
        await this.deps.trace.append("recipe.step", { id: run.id, step: id, tool, evidenceId: evidence.evidence_id, resultPath }); await persist(); return evidence;
      };
      try {
        await this.deps.withLease(async () => {
          let inputPath = asString(args["input_path"]);
          if (recipe.id === "browser-javascript") {
            const common = { cdp_endpoint: args["cdp_endpoint"], target_id: args["target_id"] };
            const capture = await step("capture", "inspect_web_page", { ...common, observation_ms: args["observation_ms"], include_script_sources: true, include_accessibility_text: true });
            const page = asRecord(capture.normalized_result); const network = asRecord(page?.["network"]); const requests = network?.["requests"];
            run.coverage["browser"] = { completeness: page?.["completeness"] ?? null, network: { observedRequests: Array.isArray(requests) ? requests.length : null, priorActivityAvailable: network?.["prior_activity_available"] ?? null, coverageStartedAt: network?.["coverage_started_at"] ?? null } };
            condition("dom-recorded", asRecord(page?.["dom"]) !== null, "DOM capture is a bounded observation");
            condition("network-minimum", Array.isArray(requests) && requests.length >= Number(args["min_network_requests"]), { observed: Array.isArray(requests) ? requests.length : null, minimum: args["min_network_requests"], priorActivityAvailable: false });
            const screenshot = await step("screenshot", "capture_web_screenshot", common); const image = asRecord(asRecord(screenshot.normalized_result)?.["artifact"]);
            const encoded = asString(image?.["data_base64"]); const bytes = Buffer.from(encoded, "base64");
            condition("screenshot-integrity", bytes.length > 0 && bytes.length <= 33_554_432 && bytes.length === image?.["bytes"] && sha(bytes) === image?.["sha256"] && bytes.toString("base64") === encoded && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])), { bytes: bytes.length, sha256: sha(bytes) });
            const screenshotPath = join(directory, "screenshot.png"); const file = await open(screenshotPath, "wx", 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } await artifact("screenshot-png", screenshotPath);
            const outputDirectory = join(directory, "scripts");
            const exported = await step("export", "export_web_scripts", { capture_path: run.steps.find(step => step.id === "capture")!.resultPath, output_directory: outputDirectory });
            const publication = asRecord(exported.normalized_result); const analysisInput = asRecord(publication?.["analysis_input"]); const manifest = asRecord(publication?.["manifest"]);
            const manifestPath = asString(manifest?.["path"]);
            if (!analysisInput) condition("scripts-exported", false, { exportedCount: 0, limitations: publication?.["limitations"] ?? [] });
            const analysisPath = asString(analysisInput?.["input_path"]);
            const outputRoot = await realpath(outputDirectory);
            const manifestRelative = manifestPath ? relative(outputRoot, await realpath(manifestPath)) : "..";
            const analysisRelative = analysisPath && isAbsolute(analysisPath) ? relative(outputRoot, await realpath(analysisPath)) : "..";
            condition("export-path", Boolean(manifestPath) && manifestRelative !== "" && !manifestRelative.startsWith("..") && !isAbsolute(manifestRelative) && !analysisRelative.startsWith("..") && !isAbsolute(analysisRelative), { outputRoot, manifestPath, analysisPath });
            const manifestBytes = await this.readArtifact(manifestPath);
            condition("export-manifest-integrity", manifestBytes.length === manifest?.["bytes"] && sha(manifestBytes) === manifest?.["sha256"], { path: manifestPath, sha256: sha(manifestBytes) }); await artifact("export-manifest", manifestPath);
            const scripts = publication?.["scripts"]; let exportedCount = 0;
            if (Array.isArray(scripts)) for (const rawScript of scripts) {
              const content = asRecord(asRecord(rawScript)?.["content"]); if (content?.["state"] !== "exported") continue;
              const path = resolve(analysisPath, asString(content["relative_path"])); const rel = relative(analysisPath, path);
              if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Exported script path leaves recipe output");
              const bytes = await this.readArtifact(path); if (bytes.length !== content["bytes"] || sha(bytes) !== content["sha256"]) throw new Error("Exported source digest/size mismatch");
              await artifact("javascript-source", path); exportedCount++;
            }
            condition("scripts-exported", exportedCount > 0, { exportedCount, limitations: publication?.["limitations"] ?? [] }); inputPath = analysisPath;
          }
          const analysis = await step("analysis", "analyze_javascript_application", { input_path: inputPath, detail: "summary", analysis_timeout_ms: args["analysis_timeout_ms"], max_heap_mb: args["max_heap_mb"] });
          const result = asRecord(analysis.normalized_result); const summary = asRecord(result?.["summary"]) ?? result; const statistics = asRecord(summary?.["statistics"]);
          run.coverage["javascript"] = { coverage: summary?.["coverage"] ?? null, unknowns: result?.["unknowns"] ?? [], limitations: result?.["limitations"] ?? analysis["limitations"] ?? [], parentEvidenceId: result?.["parent_evidence_id"] ?? analysis.evidence_id };
          condition("javascript-parsed", typeof statistics?.["parsed_javascript_files"] === "number" && statistics["parsed_javascript_files"] > 0, { parsedJavaScriptFiles: statistics?.["parsed_javascript_files"] ?? null, parseFailures: statistics?.["parse_failures"] ?? null });
          condition("native-evidence-retained", run.steps.length === recipe.steps.length, run.steps.map(step => step.evidenceId));
          run.status = "completed";
        }, signal);
      } catch (error) { run.problem = error instanceof Error ? error.message : String(error); run.status = signal?.aborted ? "cancelled" : run.steps.length || run.artifacts.length ? "partial" : "failed"; }
      run.finishedAt = new Date().toISOString(); await persist();
      await this.deps.trace.append("recipe.completed", { id: run.id, recipe: run.recipe, status: run.status, problem: run.problem, recipeSha256: run.recipeSha256, exitConditions: run.exitConditions });
      return structuredClone(run);
    }, signal);
  }
}
