import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { SubagentRunner } from "../dist/subagent.js";
import { ReaBroker } from "../dist/broker.js";
import { FakeRea } from "../dist/testing/fakes.js";
import { resolveSubagentSettings } from "../dist/modelConfig.js";
import { englishI18n } from "../dist/i18n/index.js";
import { TerminalUi } from "../dist/tui.js";
import { stripAnsi } from "../dist/ansi.js";
import { systemPrompt } from "../dist/prompts.js";
import { ExecutionStore } from "../dist/execution.js";
import { BudgetModelClient, UsageLedger } from "../dist/usage.js";

const done = {content: "done", toolCalls: [], finishReason: "stop", usage: null, reasoning: null};
const makeHarness = () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const inputs = [];
  const runner = new SubagentRunner({
    getSessionDir: () => "", getTarget: () => null, getTargetFormat: () => null,
    getBroker: async () => new ReaBroker(new FakeRea("")),
    getModel: () => ({model: "fixture", stream: async (messages) => {
      inputs.push(messages.filter(m => m.role === "user").map(m => m.content).join("\n"));
      if (inputs.length <= 4) await gate;
      return done;
    }}),
  });
  const roots = Array.from({length: 4}, (_, i) => runner.spawnNode({goal: `block ${i}`}));
  return {runner, inputs, release, roots};
};
const started = async (inputs) => {
  for (let i=0; i<100 && inputs.length<4; i++) await delay(1);
  assert.equal(inputs.length, 4);
};

describe("B03: queued and dependent worker lifecycle", () => {
  it("cancels a queued job immediately without starting its model", async () => {
    const h = makeHarness();
    try {
      await started(h.inputs);
      const queued = h.runner.spawnNode({goal: "must never start"});
      h.runner.cancel(queued.node.id);
      const result = await Promise.race([queued.promise, delay(100).then(() => null)]);
      assert.equal(result?.status, "cancelled");
      assert.equal(queued.node.turnsRun, 0);
    } finally { h.release(); await h.runner.waitFor(undefined, 1000); }
    assert.equal(h.inputs.length, 4);
  });

  it("steers a queued job through its existing execution before the first model call", async () => {
    const h = makeHarness();
    try {
      await started(h.inputs);
      const queued = h.runner.spawnNode({goal: "queued original"});
      const steered = await h.runner.steer(queued.node.id, "queued correction", {wait: false});
      assert.equal(steered.mode, "mid-flight");
      h.release();
      const result = await queued.promise;
      await h.runner.waitFor(undefined, 1000);
      assert.equal(result.status, "completed");
      assert.equal(queued.node.turnsRun, 1);
      assert.equal(h.inputs.length, 5);
      assert.match(h.inputs.at(-1), /queued original/);
      assert.match(h.inputs.at(-1), /queued correction/);
    } finally { h.release(); await h.runner.waitFor(undefined, 1000); }
  });

  it("cancels a dependency wait without waiting for the upstream task", async () => {
    const h = makeHarness();
    try {
      await started(h.inputs);
      const waiting = h.runner.spawnNode({goal: "dependent", dependsOn: [h.roots[0].node.id]});
      h.runner.cancel(waiting.node.id);
      const result = await Promise.race([waiting.promise, delay(100).then(() => null)]);
      assert.equal(result?.status, "cancelled");
    } finally { h.release(); await h.runner.waitFor(undefined, 1000); }
    assert.equal(h.inputs.length, 4);
  });

  it("rejects missing dependencies and never runs after a failed upstream task", async () => {
    let modelCalls = 0;
    const runner = new SubagentRunner({
      getSessionDir: () => "", getTarget: () => null, getTargetFormat: () => null,
      getBroker: async () => new ReaBroker(new FakeRea("")),
      getModel: () => ({model: "fixture", stream: async () => {modelCalls++; throw new Error("upstream failed");}}),
    });
    const missing = await runner.runTask({goal: "missing", dependsOn: ["absent"]});
    assert.equal(missing.status, "failed");
    assert.equal(modelCalls, 0);
    const upstream = runner.spawnNode({goal: "fail"});
    const downstream = runner.spawnNode({goal: "skip", dependsOn: [upstream.node.id]});
    assert.equal((await upstream.promise).status, "failed");
    assert.equal((await downstream.promise).status, "failed");
    assert.equal(modelCalls, 1);
  });
});

const mockBroker = () => new ReaBroker(new FakeRea(""));
const withWorkers = (settings, getModel, extra = {}) => new SubagentRunner({
  ...settings, ...extra, getModel, getBroker: async () => mockBroker(),
  getSessionDir: () => "", getTarget: () => null, getTargetFormat: () => null,
});

it("accepts only operator-configured subagent step caps", async () => {
  assert.deepEqual(resolveSubagentSettings({}, null), { maxSteps: 0, concurrency: 4 });
  assert.deepEqual(resolveSubagentSettings({}, { subagent_max_steps: 5, subagent_concurrency: 2 }), { maxSteps: 5, concurrency: 2 });
  assert.deepEqual(resolveSubagentSettings({ OMR_SUBAGENT_MAX_STEPS: "0", OMR_SUBAGENT_CONCURRENCY: "3" }, {
    subagent_max_steps: 5, subagent_concurrency: 2,
  }), { maxSteps: 0, concurrency: 3 });
  assert.deepEqual(resolveSubagentSettings({ OMR_SUBAGENT_MAX_STEPS: "1.5", OMR_SUBAGENT_CONCURRENCY: "0" }, null), { maxSteps: 0, concurrency: 4 });

  const tool = mockBroker().definitions().find((entry) => entry.function.name === "omr_task").function;
  assert.equal(Object.hasOwn(tool.parameters.properties, "max_steps"), false);
  assert.match(tool.description, /mode: 'background'.*action: 'wait'.*later step/);
  const prompt = systemPrompt({ target: null, sessionDir: "/tmp/fixture", journalPath: "/tmp/journal", directTools: [] });
  assert.match(prompt, /mode: "background".*In a later step.*action: "wait"/);
  const getModel = () => {
    let step = 0;
    return { model: "fixture", stream: async () => {
      step += 1;
      return step > 16 ? done : { ...done, content: "", finishReason: "tool_calls", toolCalls: [{
        id: `call-${step}`, type: "function", function: { name: "rea_tools", arguments: JSON.stringify({ query: `check ${step}` }) },
      }] };
    } };
  };
  for (const [env, expectedSteps, expectedStatus] of [[{}, 17, "completed"], [{ OMR_SUBAGENT_MAX_STEPS: "2" }, 2, "partial"]]) {
    const workers = withWorkers(resolveSubagentSettings(env, null), getModel);
    await workers.dispatchMetaTool({ goal: "fixture inspection", max_steps: 14 });
    const [worker] = workers.graphSnapshot().nodes;
    assert.equal(worker.totalSteps, expectedSteps, worker.error);
    assert.equal(worker.status, expectedStatus);
    if (expectedStatus === "partial") assert.equal(worker.finishReason, "step_budget");
  }
});

it("starts queued workers as soon as a slot opens and shows overlapping workers on the TUI", async () => {
  const ui = new TerminalUi({ i18n: await englishI18n(), commands: [], onSubmit() {}, onExit() {}, onInterrupt() {} });
  const directory = await mkdtemp(join(tmpdir(), "omr-worker-model-"));
  const usage = new UsageLedger(directory, new ExecutionStore("fixture", directory));
  const running = new Map();
  const windows = new Map();
  const until = async (predicate) => {
    for (let tries = 0; tries < 400 && !predicate(); tries++) await delay(5);
    assert.ok(predicate());
  };
  const workers = withWorkers(resolveSubagentSettings({ OMR_SUBAGENT_CONCURRENCY: "3" }, null), (id) => new BudgetModelClient({
    model: "fixture", stream: async () => {
      const record = { start: performance.now(), end: null };
      windows.set(id, record);
      await new Promise((release) => running.set(id, release));
      running.delete(id);
      record.end = performance.now();
      return done;
    },
  }, usage, id), { onActivity: (id, label) => ui.setSubagentActivity(id, label) });
  const ids = ["sub-1", "sub-2", "sub-3", "sub-4"];
  try {
    await Promise.all(ids.map((_, i) => workers.dispatchMetaTool({ action: "spawn", mode: "background", goal: `inspect fixture ${i}` })));
    await until(() => running.size === 3);
    const [first, second, third, fourth] = workers.graphSnapshot().nodes;
    assert.deepEqual([first.status, second.status, third.status, fourth.status], ["running", "running", "running", "queued"]);
    assert.equal(windows.has(fourth.id), false);
    const screen = ui.renderFrame(120, 40).lines.map(stripAnsi);
    assert.match(screen.at(-1), /Workers 3 sub-1 sub-2 sub-3/);
    for (const node of [first, second, third]) assert.ok(screen.slice(0, -1).some((line) => line.includes(node.id)));
    running.get(second.id)();
    await until(() => windows.has(fourth.id));
    assert.equal(running.size, 3);
    assert.ok(windows.get(fourth.id).start >= windows.get(second.id).end);
    assert.equal(windows.get(first.id).end, null);
    assert.equal(windows.get(third.id).end, null);
    assert.match(stripAnsi(ui.renderFrame(80, 30).lines.at(-1)), /Workers 3 sub-1 sub-3 sub-4/);
    for (const release of running.values()) release();
    const results = await workers.waitFor(undefined, 1_000);
    for (const result of results) assert.equal(result.status, "completed");
    assert.doesNotMatch(stripAnsi(ui.renderFrame(80, 30).lines.at(-1)), /Workers/);
  } finally {
    for (const release of running.values()) release();
    await workers.cancelAll();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps a worker alive across repeated wait windows and cancellation of a wait", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const workers = withWorkers({}, () => ({ model: "fixture", stream: async () => { await gate; return done; } }));
  try {
    await workers.dispatchMetaTool({ action: "spawn", mode: "background", goal: "deferred fixture" });
    for (let i = 0; i < 3; i++) {
      const wait = await workers.dispatchMetaTool({ action: "wait", agent_id: "sub-1", timeout_s: 0.005 });
      assert.equal(wait.isError, false);
      assert.match(wait.text, /still active.*keep calling wait or status/);
      assert.match(workers.getNodeSnapshot("sub-1").status, /queued|running/);
    }
    const controller = new AbortController();
    const waiting = workers.dispatchMetaTool({ action: "wait", agent_id: "sub-1" }, controller.signal);
    controller.abort();
    await assert.rejects(waiting, { name: "AbortError" });
    assert.match(workers.getNodeSnapshot("sub-1").status, /queued|running/);
    release();
    const doneWait = await workers.dispatchMetaTool({ action: "wait", agent_id: "sub-1", timeout_s: 1 });
    assert.match(doneWait.text, /COMPLETED/);
    assert.doesNotMatch(doneWait.text, /still active/);
  } finally {
    release();
    await workers.cancelAll();
  }
});
