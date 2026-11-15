import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Agent } from "../dist/agent.js";
import { parseArgs } from "../dist/args.js";
import { runOmr } from "../dist/runtime.js";
import { FakeModel, FakeRea } from "../dist/testing/fakes.js";

const result = (finishReason, toolCalls = []) => ({ content: "partial evidence", toolCalls, reasoning: null, finishReason, usage: null });
const modelWith = (step) => ({ model: "fixture", stream: async () => step, summarize: async () => "summary" });
const broker = { definitions: () => [], dispatch: async () => { throw new Error("must not dispatch truncated call"); } };

describe("B08/B09: explicit execution outcomes", () => {
  it("preserves incomplete model finish reasons and never executes truncated calls", async () => {
    for (const reason of ["length", "content_filter", null]) {
      const calls = reason === "length" ? [{ id: "cut", type: "function", function: { name: "side_effect", arguments: '{"cut":' } }] : [];
      const agent = new Agent(modelWith(result(reason, calls)), broker, {systemPrompt: "system"});
      const turn = await agent.run("inspect");
      assert.equal(turn.status, "partial");
      assert.equal(turn.finishReason, reason);
      assert.equal(turn.toolCalls, 0);
      assert.equal(turn.text, "partial evidence");
      assert.equal(agent.history.at(-1).tool_calls, undefined);
    }
  });

  it("distinguishes completed, cancelled, and step exhaustion", async () => {
    const agent = new Agent(modelWith(result("stop")), broker, {systemPrompt: "system"});
    assert.equal((await agent.run("ok")).status, "completed");
    assert.equal((await agent.run("cancel", {}, AbortSignal.abort())).status, "cancelled");
    const limited = new Agent(modelWith(result("stop")), broker, { systemPrompt: "system", maxSteps: 0 });
    assert.equal((await limited.run("limited")).status, "partial");
  });

  it("returns nonzero for command, model, backend, and partial failures; success stays zero", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "omr-outcomes-"));
    try {
      const run = async (command, overrides = {}) => {
        const events = [];
        const code = await runOmr({...parseArgs(["node", "omr", "--json"]), command}, {
          cwd: tmp, env: { OPENAI_API_KEY: "fixture", OMR_MODEL: "gpt-4.1" }, sessionsRootDir: join(tmp, "sessions"),
          connectRea: async (dir) => new FakeRea(dir), createModelClient: () => new FakeModel([{content: "ok"}]),
          writeStdout: (s) => events.push(JSON.parse(s)), writeStderr: () => {}, ...overrides,
        });
        return {code, events};
      };
      assert.equal((await run("/unknown-command")).code, 1);
      assert.equal((await run("/call")).code, 1);
      assert.equal((await run("/help")).code, 0);
      assert.equal((await run("/status", {connectRea: async () => { throw new Error("fixture backend failed"); }})).code, 1);
      assert.equal((await run("inspect", {createModelClient: () => ({model: "fixture", stream: async () => {throw new Error("model failed");}})})).code, 1);
      const partial = await run("inspect", {createModelClient: () => modelWith(result("length"))});
      assert.equal(partial.code, 2);
      assert.equal(partial.events.find(e => e.type === "assistant").status, "partial");
      assert.equal(partial.events.find(e => e.type === "assistant").finish_reason, "length");
      assert.equal(partial.events.at(-1).outcome, "partial");
    } finally { await rm(tmp, {recursive: true, force: true}); }
  });
});
