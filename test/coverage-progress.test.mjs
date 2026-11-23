import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Agent } from "../dist/agent.js";
import { ExecutionStore } from "../dist/execution.js";
import { ProgressTracker } from "../dist/progress.js";
import { TaskStateStore } from "../dist/taskState.js";
import { taskStateTool } from "../dist/localTools.js";
import { SessionRuntime } from "../dist/runtime/sessionRuntime.js";
import { createSession, forkSession } from "../dist/session.js";
import { FakeModel, FakeRea } from "../dist/testing/fakes.js";
import { selectJsonPointer } from "../dist/jsonPointer.js";
import { parseArgs } from "../dist/args.js";
import { OmrContext } from "../dist/runtime/context.js";
import { OutputSink } from "../dist/runtime/output.js";
import { createDefaultCommandRegistry } from "../dist/runtime.js";
import { createReadOnlySubagentBroker } from "../dist/subagent.js";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const evidence = (operation, normalized_result) => ({ evidence_id: `ev_${hash([operation, normalized_result])}`, operation, normalized_result, provider: { id: "controlled-fixture" } });
const result = payload => ({ isError: false, text: JSON.stringify(payload), payload, durationMs: 0 });
const invoke = (store, payload, tool = "inspect", backend = "rea") => store.invoke({ backend, tool, args: {}, readOnly: true, binding: null }, async () => result(payload));
const unknown = (n, status, disposition) => ({ unknown_id: `unk_${n.toString(16).padStart(64,"0")}`, revision: 1, question: `fixture question ${n}`, status, resolution: disposition ? { disposition } : null });
const fixture = (directory, options = {}) => {
  const record = evidence("fixture-inspection", { value: 42, nullable: null, "a/b": { "~key": 7 }, array: [1] }); const records = new Map(options.empty ? [] : [[record.evidence_id, record]]);
  const unknowns = [unknown(1,"open"), unknown(2,"investigating"), unknown(3,"blocked"), unknown(4,"resolved","withdrawn"), unknown(5,"resolved","verified")];
  const rea = new FakeRea(directory, { extraTools: [{ name: "verify_unknown_resolution", readOnly: true }, { name: "analyze_javascript_application", readOnly: true }], handlers: {
    get_evidence_bundle: args => {
      const selected = [...records.values()].filter(record => (!args.filters?.evidence_id || args.filters.evidence_id === record.evidence_id) && (!args.filters?.operation || args.filters.operation === record.operation));
      return { total_retained_records: records.size, matching_records: selected.length, records: args.detail === "records" ? selected : [] };
    },
    list_unknowns: args => {
      if (options.unavailableUnknowns && args.status === "blocked") return { isError: true, text: "controlled registry unavailable", payload: null, durationMs: 0 };
      const items = unknowns.filter(item => !args.status || item.status === args.status); return { items: items.slice(0, args.limit ?? 10), total: items.length, next_offset: null };
    },
    verify_unknown_resolution: args => { const item = unknowns.find(item => item.unknown_id === args.unknown_id); return { valid: item?.status === "resolved", truthVerified: item?.resolution?.disposition === "verified", unknown: item }; },
    analyze_javascript_application: args => {
      const parent = evidence("analyze_javascript_application", { input_path: args.input_path }); records.set(parent.evidence_id, parent);
      const view = evidence("inspect_analysis_view", { parent_evidence_id: parent.evidence_id, parent_operation: parent.operation, summary: { input_path: args.input_path, statistics: { parsed_javascript_files: 1, parse_failures: 0 }, coverage: { semantic: { status: "unknown" }, semantic_unknowns: 2 } }, unknowns: ["2 semantic unknowns"] }); records.set(view.evidence_id, view); return view;
    },
  } });
  return { rea, record, records, unknowns };
};
const runtime = async (root, options) => {
  const session = await createSession(null, "fixture", { rootDir: root }); const native = fixture(session.dir, options);
  const value = new SessionRuntime(session, {}, () => ({ cancelAll: async () => {} })); value.attachRea(native.rea); return { value, native, session };
};

describe("measured progress and explicit coverage", () => {
  it("counts only novel native identities, truth-verified Unknowns and passing fixture versions, including replay/fork baselines", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-progress-"));
    try {
      const store = new ExecutionStore("source", root); const progress = new ProgressTracker("source", store); const record = evidence("inspect", { answer: 42 });
      await invoke(store, record, "script", "script"); await invoke(store, { text: record.evidence_id }); await store.append("task.updated", { claim: "complete" });
      assert.equal(progress.epoch, 0);
      await invoke(store, record); await invoke(store, record); assert.equal(progress.epoch, 1); assert.equal(progress.snapshot().redundantEvidenceResults, 1);
      await invoke(store, { valid: true, truthVerified: false, unknown: unknown(4,"resolved","withdrawn") }, "verify_unknown_resolution"); assert.equal(progress.epoch, 1);
      await invoke(store, { valid: true, truthVerified: true, unknown: unknown(5,"resolved","verified") }, "verify_unknown_resolution");
      await invoke(store, { valid: true, truthVerified: true, unknown: unknown(5,"resolved","verified") }, "verify_unknown_resolution"); assert.equal(progress.epoch, 2);
      await store.append("forge.verified", { passed: false, manifestSha256: "f".repeat(64) }); assert.equal(progress.epoch, 2);
      await store.append("forge.verified", { passed: true, manifestSha256: "f".repeat(64) }); await store.append("forge.verified", { passed: true, manifestSha256: "f".repeat(64) });
      await store.append("recipe.completed", { id: "fixture", status: "completed" }); assert.equal(progress.epoch, 3);
      const restored = new ExecutionStore("source", root); const restoredProgress = new ProgressTracker("source", restored); await restored.initialize(); assert.deepEqual(restoredProgress.snapshot(), progress.snapshot());
      const branch = join(root, "branch"); await mkdir(branch); await copyFile(store.path, join(branch, "execution.jsonl"));
      const branched = new ExecutionStore("branch", branch); const branchedProgress = new ProgressTracker("branch", branched); await branched.initialize();
      assert.equal(branchedProgress.epoch, 0); assert.equal(branchedProgress.snapshot().knownEvidenceIncludingOrigin, 1);
      await invoke(branched, record); assert.equal(branchedProgress.epoch, 0);
      await invoke(branched, evidence("inspect", { answer: 43 })); assert.equal(branchedProgress.epoch, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("delivers immutable committed observations and isolates a faulty subscriber from side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-observer-"));
    try {
      const store = new ExecutionStore("fixture", root); const events = [];
      store.observe(({ event }) => { assert.ok(readFileSync(store.path,"utf8").includes(event.id)); events.push(event.type); });
      store.observe(({ event }) => { event.data.corrupt = true; });
      let effects = 0;
      await store.invoke({ backend: "fixture", tool: "effect", args: {}, readOnly: false, binding: null }, async () => { assert.deepEqual(events, ["invocation.started"]); effects++; return { ok: true }; });
      assert.equal(effects, 1); assert.deepEqual(events, ["invocation.started", "invocation.completed"]); assert.equal(store.observerErrors().length, 1); assert.equal((await store.unresolved()).length, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("extends model steps while tool calls keep succeeding (new facts, duplicates, plain exits) but never for failing calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-progress-budget-"));
    try {
      for (const mode of ["novel", "duplicate", "exit-only", "failing"]) {
        const dir = join(root, mode); await mkdir(dir); const store = new ExecutionStore(mode, dir); const progress = new ProgressTracker(mode, store);
        const broker = { definitions: () => [], isReadOnly: () => true, dispatch: async (_name, args) => { const payload = mode === "exit-only" || mode === "failing" ? { ok: true } : evidence("inspect", { n: mode === "duplicate" ? 1 : args.n }); await invoke(store, payload); return { tool: "inspect", text: JSON.stringify(payload), isError: mode === "failing", durationMs: 0, evidenceIds: [] }; } };
        const model = new FakeModel((_messages,_tools,index) => index < 3 ? { toolCalls: [{ name: "inspect", arguments: { n: index } }] } : { content: "done" });
        const agent = new Agent(model, broker, { systemPrompt: "fixture", maxSteps: 2, autoExtendSteps: 1, progressEpoch: () => progress.epoch });
        const turn = await agent.run("inspect"); assert.equal(turn.status, mode === "failing" ? "partial" : "completed", mode); assert.equal(turn.steps, mode === "failing" ? 2 : 4, mode);
        if (mode === "failing") assert.equal(turn.finishReason, "step_budget");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("separates inspected claims, exact JSON predicates, missing/null, blocked work and verified versus withdrawn Unknowns", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-coverage-assessment-")); let active;
    try {
      const fixture = await runtime(root); active = fixture.value; const ref = fixture.native.record.evidence_id;
      await active.task.update({ goal: "fixture", acceptance: [
        { id: "claim", text: "claimed", status: "claimed", proofRefs: [ref] },
        { id: "null", text: "null is observed", verification: { kind: "evidence-equals", ref, pointer: "/normalized_result/nullable", equals: null } },
        { id: "missing", text: "missing is not null", verification: { kind: "evidence-equals", ref, pointer: "/normalized_result/missing", equals: null } },
        { id: "escaped", text: "exact escaped key", verification: { kind: "evidence-equals", ref, pointer: "/normalized_result/a~1b/~0key", equals: 7 } },
        { id: "blocked", text: "blocked", status: "blocked", verification: { kind: "evidence-equals", ref, pointer: "/normalized_result/value", equals: 42 } },
        { id: "unknown", text: "verified resolution", verification: { kind: "unknown-resolution", ref: fixture.native.unknowns[4].unknown_id } },
        { id: "withdrawn", text: "withdrawn is not verified", verification: { kind: "unknown-resolution", ref: fixture.native.unknowns[3].unknown_id } },
      ] }, 0);
      const report = await active.coverage.report(); const items = Object.fromEntries(report.acceptance.items.map(item => [item.id,item]));
      assert.equal(report.goalStatus, "in_progress"); assert.equal(items.claim.assessment, "inspected"); assert.equal(items.null.assessment, "verified"); assert.equal(items.missing.verification.passed, false); assert.match(items.missing.verification.reason, /does not exist/);
      assert.equal(items.escaped.assessment, "verified"); assert.equal(items.blocked.assessment, "blocked"); assert.equal(items.unknown.assessment, "verified"); assert.equal(items.withdrawn.assessment, "unverified");
      assert.equal(report.unknowns.openTotal, 3); assert.equal(report.ledger.totalRetainedRecords, 1); assert.equal(report.progress.verifiedUnknowns, 1);
      const epoch = active.progress.epoch; await active.coverage.report(); assert.equal(active.progress.epoch, epoch, "coverage refresh manufactured progress");
      assert.equal((await active.coverage.report({ itemId: "null" })).goalStatus, "partially_assessed");
      assert.equal(selectJsonPointer({ array: [1] }, "/array/length").found, false); assert.equal(selectJsonPointer({}, "/__proto__").found, false);
    } finally { await active?.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("keeps registry outages unknown and validates actual Forge/recipe proofs instead of claimed references", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-coverage-proofs-")); let active;
    try {
      const fixture = await runtime(root, { unavailableUnknowns: true }); active = fixture.value;
      const spec = { id: "constant", version: "1.0.0", description: "fixture constant", interpreter: "node", inputSchema: { type: "object" }, outputSchema: { type: "integer" }, fixtures: [{ id: "constant", input: {}, expected: 42 }] };
      await active.forge.register(spec, "console.log(42)"); const proof = await active.forge.verify("constant","1.0.0");
      const run = await active.recipes.run("javascript", { input_path: root }); assert.equal(run.status, "completed", run.problem);
      await active.task.update({ acceptance: [{ id: "fixture", text: "fixture passed", verification: { kind: "forge-fixtures", ref: proof.ref } }, { id: "recipe", text: "pipeline conditions", verification: { kind: "recipe-exit", ref: `recipe:${run.id}` } }] }, 0);
      const report = await active.coverage.report(); assert.equal(report.goalStatus, "acceptance_conditions_met"); assert.equal(report.unknowns.openTotal, null, "unavailable Unknowns were reported as zero");
      assert.equal(report.providerCoverage[0].coverage.javascript.coverage.semantic_unknowns, 2);
      await active.forge.remove("constant"); await writeFile(run.artifacts[0].path, "tampered");
      const changed = await active.coverage.report(); assert.equal(changed.goalStatus, "in_progress"); assert.ok(changed.acceptance.items.every(item => item.verification.passed === false));
    } finally { await active?.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("does not promote historical fork references when the new backend lacks their Evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-coverage-fork-")); let source, branch;
    try {
      const original = await runtime(root); source = original.value;
      const analysis = await source.rea.call("analyze_javascript_application", { input_path: root }); const ref = analysis.payload.evidence_id;
      await source.task.update({ acceptance: [{ id: "analysis", text: "one parsed source", verification: { kind: "evidence-equals", ref, pointer: "/normalized_result/summary/statistics/parsed_javascript_files", equals: 1 } }] }, 0);
      assert.equal((await source.coverage.report()).goalStatus, "acceptance_conditions_met"); await source.events.flush();
      const copied = await forkSession(original.session, [], null, "fixture", { rootDir: root }); branch = new SessionRuntime(copied, {}, () => ({ cancelAll: async () => {} })); branch.attachRea(fixture(copied.dir, { empty: true }).rea); await branch.setOrigin(original.session, "fork");
      const report = await branch.coverage.report(); assert.equal(report.goalStatus, "in_progress"); assert.equal(report.acceptance.items[0].assessment, "unverified"); assert.equal(report.progress.newEvidence, 0); assert.ok(report.progress.knownEvidenceIncludingOrigin > 0); assert.equal(report.origin.status, "unverified");
    } finally { await source?.close(); await branch?.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("retains long goals completely and reads large task fields in valid bounded pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-state-pages-"));
    try {
      const store = new TaskStateStore(root); const goal = "first" + "x".repeat(80_000) + "last"; await store.initializeGoal(goal);
      assert.equal((await new TaskStateStore(root).read()).goal, goal); assert.ok(store.contextNote().length < 8500);
      const tool = taskStateTool(store); const page = await tool.invoke({ action: "get", path: "/goal", offset: 79_000, limit: 2000 });
      assert.equal(page.structuredContent.value, goal.slice(79_000)); assert.equal(page.structuredContent.nextOffset, null); JSON.parse(page.text);
      const overview = await tool.invoke({ action: "get" }); assert.equal(overview.structuredContent.omitted, true); assert.ok(overview.structuredContent.keys.includes("goal")); JSON.parse(overview.text);
      const update = await tool.invoke({ action: "update", expected_revision: 1, patch: { constraints: ["preserve full goal"] } }); assert.equal(update.structuredContent.updated, true); assert.equal(update.structuredContent.revision, 2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("exposes coverage through the real CLI and read-only child tool without starting a model", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-coverage-cli-")); let ctx; let modelClients = 0; const output = [];
    try {
      const session = await createSession(null, null, { rootDir: root }); const native = fixture(session.dir);
      ctx = new OmrContext({ opts: parseArgs(["node", "omr", "--json", "--no-model"]), cwd: root, env: {}, sources: [], session, sessionsRootDir: root, currentTarget: null, currentMagic: null,
        output: new OutputSink({ json: true, writeStdout: value => output.push(value), writeStderr: value => output.push(value) }), deps: { connectRea: async () => native.rea, createModelClient: () => { modelClients++; throw new Error("no model should be started"); } } });
      await ctx.runtime.task.update({ acceptance: [{ id: "claim", text: "inspection alone is not verification", status: "claimed", proofRefs: [native.record.evidence_id] }] }, 0);
      const outcome = await createDefaultCommandRegistry().dispatchCommand(ctx, "/coverage");
      assert.equal(outcome.status, "completed", output.join("\n")); assert.equal(modelClients, 0);
      const report = output.flatMap(value => value.split("\n")).filter(Boolean).map(value => JSON.parse(value)).find(value => value.type === "command.result" && value.command === "coverage").payload;
      assert.equal(report.schema, "omr-coverage/v1"); assert.equal(report.acceptance.items[0].assessment, "inspected"); assert.equal(report.goalStatus, "in_progress");
      const child = createReadOnlySubagentBroker(ctx.broker); const result = await child.dispatch("omr_coverage", { item_id: "claim" });
      assert.equal(result.isError, false, result.text); assert.equal(result.structuredContent.acceptance.items[0].assessment, "inspected"); assert.equal((await ctx.runtime.task.read()).revision, 1);
    } finally { await ctx?.shutdown("complete"); await rm(root, { recursive: true, force: true }); }
  });
});
