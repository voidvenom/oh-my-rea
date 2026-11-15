import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RecipeEngine } from "../dist/recipes.js";
import { ExecutionStore } from "../dist/execution.js";
import { FakeModel, FakeRea } from "../dist/testing/fakes.js";
import { createSession } from "../dist/session.js";
import { parseArgs } from "../dist/args.js";
import { OmrContext } from "../dist/runtime/context.js";
import { OutputSink } from "../dist/runtime/output.js";
import { createDefaultCommandRegistry } from "../dist/runtime.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const sha = value => createHash("sha256").update(value).digest("hex");
const canonical = (operation, normalized_result) => ({ evidence_id: `ev_${sha(JSON.stringify([operation, normalized_result]))}`, operation, normalized_result, provider: { id: "controlled-fixture", name: "fixture", version: "1" }, confidence: "observed", authority: "controlled-replay", limitations: [] });
const native = (root, options = {}) => {
  const records = new Map(); let captureCalls = 0;
  const retain = (operation, data) => { const record = canonical(operation, data); records.set(record.evidence_id, record); return record; };
  const rea = new FakeRea(root, { extraTools: ["inspect_web_page", "capture_web_screenshot", "export_web_scripts", "analyze_javascript_application"].map(name => ({ name, readOnly: name !== "export_web_scripts" })), handlers: {
    inspect_web_page: async (_args, callOptions) => {
      captureCalls++;
      if (options.waitForAbort) { options.onCapture?.(); await new Promise((_resolve, reject) => { const onAbort = () => reject(callOptions.signal.reason); if (callOptions.signal.aborted) onAbort(); else callOptions.signal.addEventListener("abort", onAbort, { once: true }); }); }
      return retain("inspect_web_page", { target: { target_id: "page-1", url: "http://127.0.0.1/" }, dom: { documents: [{}] }, network: { requests: [{ method: "GET", url: "http://127.0.0.1/api/ping" }], prior_activity_available: false, coverage_started_at: "2026-11-11T00:00:00Z" }, completeness: { status: "attach_limited", attach_limited_sections: ["network_requests"] }, scripts: { total: 1, items: [] } });
    },
    capture_web_screenshot: () => retain("capture_web_screenshot", { target: { target_id: "page-1" }, artifact: { data_base64: png.toString("base64"), bytes: png.length, sha256: options.badScreenshot ? "0".repeat(64) : sha(png), media_type: "image/png" } }),
    export_web_scripts: async args => {
      const capture = JSON.parse(await readFile(args.capture_path, "utf8")); assert.equal(capture.operation, "inspect_web_page");
      const files = join(args.output_directory, "files"); await mkdir(files, { recursive: true }); const source = "export const fixture = 42;\n"; await writeFile(join(files, "app.js"), source);
      const publication = { capture_path: args.capture_path, capture_sha256: sha(await readFile(args.capture_path)), source_evidence_id: capture.evidence_id, output_directory: args.output_directory, analysis_input: { input_path: files, format: "directory" }, scripts: [{ content: { state: "exported", relative_path: "app.js", bytes: Buffer.byteLength(source), sha256: sha(source) } }], limitations: ["bounded observation"] };
      const text = JSON.stringify(publication); const path = join(args.output_directory, "manifest.json"); await writeFile(path, text);
      return retain("export_web_scripts", { ...publication, manifest: { path, sha256: sha(text), bytes: Buffer.byteLength(text) } });
    },
    analyze_javascript_application: args => {
      const parent = retain("analyze_javascript_application", { input_path: args.input_path, graph: { nodes: ["fixture"] } });
      return retain("inspect_analysis_view", { parent_evidence_id: parent.evidence_id, parent_operation: "analyze_javascript_application", summary: { input_path: args.input_path, statistics: { parsed_javascript_files: 1, parse_failures: 0 }, coverage: { application: { status: "complete" }, semantic: { status: "unknown" }, semantic_unknowns: 3 } }, unknowns: ["3 semantic unknowns remain"] });
    },
    get_evidence_bundle: args => ({ records: options.missingEvidence ? [] : records.has(args.filters?.evidence_id) ? [records.get(args.filters.evidence_id)] : [], matching_records: records.has(args.filters?.evidence_id) ? 1 : 0 }),
  } });
  return { rea, records, captureCalls: () => captureCalls };
};
const engine = (root, rea, signal = new AbortController().signal) => new RecipeEngine({ sessionId: "fixture-session", directory: root, trace: new ExecutionStore("fixture-session", root), signal, rea: () => rea, binding: () => ({ sessionId: "fixture-session", target: null, epoch: 1 }), activeCdpEndpoint: () => "http://127.0.0.1:9222", assertRecoveryReady: async () => {}, withLease: work => work() });

describe("versioned analysis recipes and native Evidence receipts", () => {
  it("records the full DOM/network/screenshot/export/JS episode and preserves explicit unknown coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-recipe-episode-"));
    try {
      const fixture = native(root); const recipes = engine(root, fixture.rea);
      const run = await recipes.run("browser-javascript", { target_id: "page-1", min_network_requests: 1 });
      assert.equal(run.status, "completed", run.problem); assert.equal(run.steps.length, 4); assert.ok(run.exitConditions.every(condition => condition.passed));
      assert.equal(run.coverage.browser.network.observedRequests, 1); assert.equal(run.coverage.browser.completeness.status, "attach_limited");
      assert.equal(run.coverage.javascript.coverage.semantic.status, "unknown"); assert.equal(run.coverage.javascript.coverage.semantic_unknowns, 3);
      assert.equal(await recipes.resolveProof(run.id), true);
      const replay = await recipes.run("browser-javascript", { target_id: "page-1", min_network_requests: 1 });
      assert.equal(replay.status, "completed", replay.problem); assert.notEqual(replay.id, run.id); assert.equal(replay.recipeSha256, run.recipeSha256);
      assert.notEqual(replay.steps[2].args.output_directory, run.steps[2].args.output_directory);
      const source = run.artifacts.find(artifact => artifact.kind === "javascript-source"); await writeFile(source.path, "tampered");
      assert.equal(await recipes.resolveProof(run.id), false); assert.equal(await recipes.resolveProof(replay.id), true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("checks entry capabilities before side effects and rejects ambiguous input", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-recipe-entry-"));
    try {
      const rea = new FakeRea(root); const recipes = engine(root, rea);
      await assert.rejects(recipes.run("javascript", { input_path: root }), /missing tools/); assert.equal(rea.calls.length, 0);
      await assert.rejects(recipes.run("browser-javascript", {}), /target_id/);
      await assert.rejects(recipes.run("javascript", { input_path: root, unexpected: 1 }), /Unknown/);
      await assert.rejects(recipes.run("javascript", { input_path: "relative" }), /absolute/);
      await assert.rejects(recipes.run("javascript", { input_path: root, max_heap_mb: 1 }), /at least 128/);
      assert.deepEqual(await recipes.recent(), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not accept a citation-shaped record that the active Evidence ledger does not retain", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-recipe-evidence-"));
    try {
      const fixture = native(root, { missingEvidence: true }); const recipes = engine(root, fixture.rea);
      const run = await recipes.run("javascript", { input_path: root });
      assert.equal(run.status, "partial"); assert.match(run.problem, /missing or differs/);
      assert.equal(run.steps.length, 0); assert.equal(await recipes.resolveProof(run.id), false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects screenshot digest failure and unmet network thresholds without running dependent analysis", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-recipe-exit-"));
    try {
      for (const [options, input, condition] of [[{ badScreenshot: true }, { target_id: "page-1" }, "screenshot-integrity"], [{}, { target_id: "page-1", min_network_requests: 2 }, "network-minimum"]]) {
        const fixture = native(root, options); const recipes = engine(root, fixture.rea);
        const run = await recipes.run("browser-javascript", input);
        assert.equal(run.status, "partial"); assert.match(run.problem, new RegExp(condition));
        assert.equal(fixture.rea.calls.some(call => call.name === "analyze_javascript_application"), false);
        assert.equal(run.exitConditions.at(-1).passed, false); assert.equal(await recipes.resolveProof(run.id), false);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("records cancellation once and never silently retries the interrupted capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-recipe-cancel-")); let started;
    const captured = new Promise(resolve => { started = resolve; }); const abort = new AbortController();
    try {
      const fixture = native(root, { waitForAbort: true, onCapture: started }); const recipes = engine(root, fixture.rea);
      const pending = recipes.run("browser-javascript", { target_id: "page-1" }, abort.signal); await captured; abort.abort();
      const run = await pending; assert.equal(run.status, "cancelled"); assert.equal(fixture.captureCalls(), 1);
      assert.equal((await recipes.inspect(run.id)).status, "cancelled"); assert.equal(await recipes.resolveProof(run.id), false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("exposes recipe runs to the actual agent and preserves typed partial CLI outcomes", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-recipe-runtime-")); let ctx; const output = [];
    const model = new FakeModel([{ toolCalls: [{ name: "omr_recipe", arguments: { action: "run", recipe: "javascript", input: { input_path: root } } }] }, { content: "retained syntax observations, semantics remain unknown" }]);
    try {
      const session = await createSession(null, "fixture", { rootDir: root }); const fixture = native(session.dir);
      ctx = new OmrContext({ opts: parseArgs(["node", "omr", "--json"]), cwd: root, env: { OPENAI_API_KEY: "fixture", OMR_MODEL: "gpt-4.1" }, sources: [], session, sessionsRootDir: root, currentTarget: null, currentMagic: null,
        output: new OutputSink({ json: true, writeStdout: value => output.push(value), writeStderr: value => output.push(value) }), deps: { connectRea: async () => fixture.rea, createModelClient: () => model } });
      await ctx.runTurn("run a static recipe", "fixture");
      assert.ok(ctx.agent.history.some(message => message.role === "tool" && message.content.includes('"status":"completed"')));
      const outcome = await createDefaultCommandRegistry().dispatchCommand(ctx, '/recipe run browser-javascript {"cdp_endpoint":"http://127.0.0.1:9222","target_id":"page-1","min_network_requests":2}');
      assert.equal(outcome.status, "partial", output.join("\n")); assert.match(outcome.finishReason, /network-minimum/);
      const recent = await ctx.runtime.recipes.recent(); assert.equal(recent.length, 2);
    } finally { await ctx?.shutdown("complete"); await rm(root, { recursive: true, force: true }); }
  });
});
