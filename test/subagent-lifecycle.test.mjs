import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { SubagentRunner } from "../dist/subagent.js";
import { ReaBroker } from "../dist/broker.js";
import { FakeRea } from "../dist/testing/fakes.js";

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
