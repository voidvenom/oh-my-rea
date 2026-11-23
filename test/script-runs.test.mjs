import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ReaBroker } from "../dist/broker.js";
import { ExecutionStore } from "../dist/execution.js";
import { forgeManagementTool, recipeTool } from "../dist/localTools.js";
import { LoopGuard } from "../dist/loopGuard.js";
import { SessionScriptRuns } from "../dist/scriptRuns.js";
import { FakeRea } from "../dist/testing/fakes.js";

test("a model wait window returns partial output and leaves one recorded script running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omr-live-script-"));
  const runs = new SessionScriptRuns();
  const execution = new ExecutionStore("fixture", dir);
  const brokerOptions = { scriptsDir: () => dir, scriptRuns: runs, scriptEnv: {}, execution };
  const broker = new ReaBroker(new FakeRea(""), brokerOptions);
  try {
    const definition = broker.definitions().find((entry) => entry.function.name === "omr_run").function;
    assert.equal(Object.hasOwn(definition.parameters.properties, "timeout_s"), false);
    const initial = await broker.dispatch("omr_run", {
      script: "observe.mjs", timeout_s: 0.01,
      code: `import { existsSync } from "node:fs";
console.log("partial stdout");
console.error("partial stderr");
const wait = setInterval(() => {
  if (existsSync(".release")) { clearInterval(wait); console.log("finished output"); }
}, 10);`,
    });
    assert.equal(initial.isError, false);
    const id = initial.structuredContent.run_id;
    assert.match(initial.text, /queued|still running/);
    assert.equal(broker.isReadOnly("omr_run", { run_id: id }), true);

    // The same session can still monitor this run through a replacement broker.
    const replacement = new ReaBroker(new FakeRea(""), brokerOptions);
    let snapshot;
    for (let i = 0; i < 50; i++) {
      snapshot = await replacement.dispatch("omr_run", { run_id: id, wait_s: 0.05 });
      if (snapshot.text.includes("partial stderr")) break;
    }
    assert.match(snapshot.text, /still running/);
    assert.match(snapshot.text, /partial stdout/);
    assert.match(snapshot.text, /partial stderr/);
    assert.equal((await execution.unresolved()).length, 1);
    assert.equal((await execution.recoveryPending()).length, 0);
    const duplicate = await broker.dispatch("omr_run", { script: "observe.mjs", code: "throw new Error('unexpected relaunch')" });
    assert.equal(duplicate.isError, true);
    assert.match(duplicate.text, /already active/);

    await writeFile(join(dir, ".release"), "");
    const finished = await replacement.dispatch("omr_run", { run_id: id, wait_s: 2 });
    assert.equal(finished.isError, false);
    assert.match(finished.text, /exit 0/);
    assert.match(finished.text, /finished output/);
    assert.equal((await execution.unresolved()).length, 0);

    const started = await broker.dispatch("omr_run", {
      script: "cancellable.mjs", code: "console.log('ready to cancel'); setInterval(() => {}, 1000);", wait_s: 0,
    });
    const cancelId = started.structuredContent.run_id;
    for (let i = 0; i < 50; i++) {
      snapshot = await broker.dispatch("omr_run", { run_id: cancelId, wait_s: 0.05 });
      if (snapshot.text.includes("ready to cancel")) break;
    }
    assert.match(snapshot.text, /ready to cancel/);
    assert.equal(broker.isReadOnly("omr_run", { action: "cancel", run_id: cancelId }), false);
    const cancelled = await broker.dispatch("omr_run", { action: "cancel", run_id: cancelId, wait_s: 2 });
    assert.equal(cancelled.isError, true);
    assert.match(cancelled.text, /ABORTED/);
    assert.match(cancelled.text, /ready to cancel/);
    assert.equal((await execution.unresolved()).length, 0);
  } finally {
    await runs.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live run and subagent polls can be repeated without loop guard notices", () => {
  const guard = new LoopGuard();
  for (const [tool, args] of [["omr_run", { run_id: "run" }], ["omr_task", { action: "wait", agent_id: "sub-1" }]]) {
    for (let i = 0; i < 20; i++) {
      assert.equal(guard.check(tool, args, true), null);
      guard.record(tool, args, true, false);
    }
  }
});

test("model Forge and recipe calls ignore operator-only resource overrides", async () => {
  const forge = forgeManagementTool({ register: async (spec) => spec });
  const recipe = recipeTool({ run: async (_name, input) => ({ input, status: "completed" }) });
  assert.equal(Object.hasOwn(forge.definition.function.parameters.properties.spec.properties, "timeoutSec"), false);
  const registration = await forge.invoke({ action: "register", code: "fixture", spec: { id: "keep", timeoutSec: 1 } });
  assert.deepEqual(registration.structuredContent, { id: "keep" });
  const schema = recipe.definition.function.parameters.properties.input.properties;
  assert.equal(Object.hasOwn(schema, "analysis_timeout_ms"), false);
  assert.equal(Object.hasOwn(schema, "max_heap_mb"), false);
  const result = await recipe.invoke({ action: "run", recipe: "javascript", input: { input_path: "/tmp/fixture.js", analysis_timeout_ms: 1, max_heap_mb: 128 } });
  assert.deepEqual(result.structuredContent.input, { input_path: "/tmp/fixture.js" });
});
