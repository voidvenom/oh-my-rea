import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { Rea } from "../dist/rea.js";
import { ReaBroker } from "../dist/broker.js";
import { Agent } from "../dist/agent.js";
import { FakeModel, FakeRea } from "../dist/testing/fakes.js";
import { InvocationNotDispatchedError } from "../dist/execution.js";
import { SessionRuntime } from "../dist/runtime/sessionRuntime.js";
import { createSession } from "../dist/session.js";

const connect = dir => Rea.connect(dir, { PATH: process.env.PATH, OMR_REA_COMMAND: fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url)), OMR_FIXTURE_MODE: "catalog-change" }, []);

describe("MCP catalog lifecycle and resolved identity", () => {
  it("refreshes paginated tools and prompts atomically after actual SDK list_changed notifications", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-catalog-")); let rea;
    try {
      rea = await connect(root); const broker = new ReaBroker(rea); broker.promoteTools(["fixture_same", "fixture_old"]);
      assert.ok(rea.find("fixture_old")); assert.equal((await rea.prompts())[0].name, "prompt_0");
      assert.equal(broker.definitions().find(tool => tool.function.name === "fixture_same").function.parameters.properties.value.type, "string");
      const before = broker.catalogVersion(); await rea.call("fixture_control", { action: "change" });
      assert.throws(() => rea.tools(), /refreshing/);
      const refresh = rea.refreshTools(); assert.equal(refresh, rea.refreshTools(), "refresh was not single-flight"); await refresh;
      assert.equal(rea.find("fixture_old"), undefined); assert.ok(rea.find("fixture_new"));
      assert.equal((await rea.prompts())[0].name, "prompt_1");
      assert.equal(broker.definitions().find(tool => tool.function.name === "fixture_same").function.parameters.properties.value.type, "integer");
      assert.equal(broker.isReadOnly("fixture_same", {}), false); assert.notEqual(broker.catalogVersion(), before);
      const stats = (await rea.call("fixture_control", { action: "stats" })).payload;
      assert.ok(stats.listRequests >= 4 && stats.listRequests <= 6, `refresh burst fetched ${stats.listRequests} pages`);
    } finally { await rea?.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("blocks stale schemas after failed refresh and permits an explicit recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-catalog-error-")); let rea;
    try {
      rea = await connect(root); await rea.call("fixture_control", { action: "change", fail: true });
      await assert.rejects(rea.refreshTools(), /controlled refresh failure/);
      assert.throws(() => rea.find("fixture_same"), /refresh failed/); assert.match(rea.diagnostics(), /controlled refresh failure/);
      await assert.rejects(rea.call("fixture_same", { value: "old schema" }), InvocationNotDispatchedError);
      await rea.refreshTools(); assert.equal(rea.find("fixture_same").inputSchema.properties.value.type, "integer");
      assert.equal((await rea.call("fixture_control", { action: "stats" })).payload.effectCalls, 0);
    } finally { await rea?.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("uses the same browser/native collision identity for schemas, hints and direct/nested execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-collision-")); let nativeCalls = 0, browserCalls = 0;
    try {
      const rea = new FakeRea(root, { extraTools: [{ name: "camofox_snapshot", description: "REA snapshot contract", readOnly: false, inputSchema: { type: "object", properties: { native_marker: { type: "integer" } } } }], handlers: { camofox_snapshot: () => { nativeCalls++; return { native: true }; } } });
      const broker = new ReaBroker(rea, { browser: { call: async name => { browserCalls++; return { text: "owned browser", isError: false, durationMs: 0 }; } } });
      broker.promoteTools(["camofox_snapshot", "rea__camofox_snapshot"]);
      const definitions = broker.definitions();
      assert.equal(definitions.find(tool => tool.function.name === "camofox_snapshot").function.parameters.properties.native_marker, undefined);
      assert.equal(definitions.find(tool => tool.function.name === "rea__camofox_snapshot").function.parameters.properties.native_marker.type, "integer");
      assert.equal(broker.isReadOnly("camofox_snapshot", {}), true); assert.equal(broker.isReadOnly("rea__camofox_snapshot", {}), false);
      assert.equal((await broker.dispatch("camofox_snapshot", {})).text, "owned browser");
      assert.equal((await broker.dispatch("rea_call", { name: "rea__camofox_snapshot", arguments: { native_marker: 7 } })).isError, false);
      assert.equal(nativeCalls, 1); assert.equal(browserCalls, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a model call made against an earlier same-name schema and exposes the replacement next step", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-stale-model-tool-")); let calls = 0;
    try {
      const rea = new FakeRea(root, { extraTools: [{ name: "fixture_mutate", readOnly: false, inputSchema: { type: "object", properties: { old_field: { type: "string" } } } }], handlers: { fixture_mutate: () => { calls++; return { changed: true }; } } });
      const broker = new ReaBroker(rea); broker.promoteTools(["fixture_mutate"]);
      const model = new FakeModel((_messages, _tools, index) => {
        if (index === 0) { rea.find("fixture_mutate").inputSchema = { type: "object", properties: { new_field: { type: "integer" } } }; return { toolCalls: [{ name: "fixture_mutate", arguments: { old_field: "stale" } }] }; }
        return { content: "inspect the new schema before acting" };
      });
      const agent = new Agent(model, broker, { systemPrompt: "fixture", maxSteps: 3 }); await agent.run("inspect", {});
      assert.equal(calls, 0); assert.match(agent.history.find(message => message.role === "tool").content, /catalog changed/);
      assert.equal(model.requests[1].tools.find(tool => tool.function.name === "fixture_mutate").function.parameters.properties.new_field.type, "integer");
      const catalog = rea.tools(); catalog.splice(catalog.findIndex(tool => tool.name === "fixture_mutate"), 1);
      assert.equal((await broker.dispatch("fixture_mutate", {})).isError, true, "removed catalog entry still dispatched through stale byName");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rechecks native revisions after waiting for a target lease without leaving uncertain effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-queued-catalog-")); let rea, runtime, release;
    try {
      const session = await createSession(null, "fixture", { rootDir: root }); rea = await connect(session.dir);
      runtime = new SessionRuntime(session, {}, () => ({ cancelAll: async () => {} })); const port = runtime.attachRea(rea);
      let started; const held = new Promise(resolve => { started = resolve; }); const gate = new Promise(resolve => { release = resolve; });
      const reader = runtime.withTargetLease(runtime.binding, async () => { started(); await gate; }); await held;
      const mutation = port.call("open_binary", { path: "/fixture" });
      // Attach rejection observation before releasing the gate.
      const rejected = assert.rejects(mutation, InvocationNotDispatchedError);
      await rea.call("fixture_control", { action: "change" }); await rea.refreshTools();
      release(); await reader; await rejected;
      assert.equal((await runtime.events.recoveryPending()).length, 0);
      assert.equal((await rea.call("fixture_control", { action: "stats" })).payload.effectCalls, 0);
    } finally { release?.(); if (runtime) await runtime.close(); else await rea?.close(); await rm(root, { recursive: true, force: true }); }
  });
});
