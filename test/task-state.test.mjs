import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TaskStateStore } from "../dist/taskState.js";
import { taskStateTool } from "../dist/localTools.js";
import { ReaBroker } from "../dist/broker.js";
import { createReadOnlySubagentBroker } from "../dist/subagent.js";
import { createSession, saveSessionHistory } from "../dist/session.js";
import { parseArgs } from "../dist/args.js";
import { OmrContext } from "../dist/runtime/context.js";
import { OutputSink } from "../dist/runtime/output.js";
import { createDefaultCommandRegistry } from "../dist/runtime.js";
import { FakeModel, FakeRea } from "../dist/testing/fakes.js";

const context = async root => {
  const session = await createSession(null, "fixture", { rootDir: root });
  const model = new FakeModel(() => ({ content: "finding" }));
  let connections = 0;
  const ctx = new OmrContext({ opts: parseArgs(["node", "omr", "--json"]), cwd: root, env: { OPENAI_API_KEY: "fixture", OMR_MODEL: "gpt-4.1" }, sources: [], session, sessionsRootDir: root,
    currentTarget: null, currentMagic: null, output: new OutputSink({ json: true, writeStdout: () => {}, writeStderr: () => {} }),
    deps: { connectRea: async dir => { connections++; return new FakeRea(dir); }, createModelClient: () => model } });
  return { ctx, model, connections: () => connections };
};

describe("persistent task state", () => {
  it("persists independent revisions, rejects lost updates and never accepts self-declared verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-task-store-"));
    try {
      const store = new TaskStateStore(root);
      await Promise.all([store.initializeGoal("original purpose"), store.initializeGoal("racing purpose")]);
      const original = await store.read(); assert.equal(original.revision, 1);
      const updates = await Promise.allSettled([
        store.update({ constraints: ["retain provenance"] }, 1),
        store.update({ constraints: ["lost update"] }, 1),
      ]);
      assert.equal(updates.filter(result => result.status === "fulfilled").length, 1);
      assert.match(String(updates.find(result => result.status === "rejected").reason), /revision conflict/);
      const claimed = await store.update({ acceptance: [{ id: "a", text: "decode fixture", status: "claimed", proofRefs: ["ev_unverified"] }] }, 2);
      assert.equal(claimed.acceptance[0].status, "claimed");
      await assert.rejects(store.update({ acceptance: [{ id: "a", text: "trust me", status: "verified" }] }, 3), /verification is derived/);
      await assert.rejects(store.update({ decisions: [{ id: "x", text: "a" }, { id: "x", text: "b" }] }, 3), /Duplicate/);
      await assert.rejects(store.update({ revision: 99 }, 3), /Unknown/);
      assert.deepEqual(await new TaskStateStore(root).read(), claimed);
      assert.match(store.contextNote(), /Claimed acceptance is not verified/);
      await writeFile(store.path, '{"schema":1,"revision":-1}');
      await assert.rejects(new TaskStateStore(root).read(), /Invalid saved task state/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("exposes local tools on cache hits, preserves dynamic lifecycle and blocks child writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-task-broker-"));
    try {
      const store = new TaskStateStore(root); const tool = taskStateTool(store); let local = [tool];
      const broker = new ReaBroker(new FakeRea(root), { localTools: () => local });
      broker.promoteTools(["omr_state"]);
      for (let i = 0; i < 3; i++) assert.equal(broker.definitions().filter(def => def.function.name === "omr_state").length, 1);
      const child = createReadOnlySubagentBroker(broker);
      assert.equal((await child.dispatch("omr_state", { action: "get" })).isError, false);
      assert.equal((await child.dispatch("rea_call", { name: "omr_state", arguments: { action: "update", expected_revision: 0, patch: { goal: "child clobber" } } })).isError, true);
      assert.equal((await store.read()).goal, "");
      const updated = await broker.dispatch("omr_state", { action: "update", expected_revision: 0, patch: { goal: "parent task" } });
      assert.equal(updated.isError, false, updated.text);
      const abort = new AbortController(); abort.abort();
      assert.equal((await broker.dispatch("omr_state", { action: "update", expected_revision: 1, patch: { goal: "cancelled" } }, abort.signal)).isError, true);
      assert.equal((await store.read()).goal, "parent task");
      local = []; assert.equal(broker.definitions().some(def => def.function.name === "omr_state"), false);
      local = [{ ...tool, definition: { ...tool.definition, function: { ...tool.definition.function, name: "search_strings" } } }];
      assert.throws(() => broker.definitions(), /name collision/);
      await assert.rejects(broker.dispatch("search_strings", {}), /name collision/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps task facts through compaction, rewind, fork and resume with independent branch updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-task-runtime-")); let ctx;
    try {
      const fixture = await context(root); ctx = fixture.ctx; const registry = createDefaultCommandRegistry();
      const patch = { goal: "preserved investigation", constraints: ["keep original bytes"], decisions: [{ id: "d1", text: "inspect decoder first" }], activeWork: [{ id: "w1", text: "fixture validation" }], artifacts: [{ id: "source", path: "/historical/source.py", originSessionId: ctx.session.id }] };
      assert.equal((await registry.dispatchCommand(ctx, `/state update 0 ${JSON.stringify(patch)}`)).status, "completed");
      assert.equal(fixture.connections(), 0, "local state command started REA");
      await ctx.runTurn("shorter follow-up", "fixture");
      ctx.agent.compact({ force: true, targetBudget: 0 });
      await registry.dispatchSlashLine(ctx, "/rewind 1");
      await ctx.runTurn("continue", "fixture");
      assert.match(JSON.stringify(fixture.model.requests.at(-1).messages), /preserved investigation/);
      assert.match(JSON.stringify(fixture.model.requests.at(-1).messages), /keep original bytes/);
      const source = ctx.session; const state = await ctx.runtime.task.read();
      await registry.dispatchSlashLine(ctx, "/fork task-branch");
      assert.deepEqual(await ctx.runtime.task.read(), state);
      await ctx.runtime.task.update({ goal: "branch purpose" }, state.revision);
      assert.equal(JSON.parse(await readFile(join(source.dir, "task-state.json"), "utf8")).goal, "preserved investigation");
      await registry.dispatchSlashLine(ctx, `/resume ${source.id}`);
      const resumed = await ctx.runtime.task.read();
      assert.equal(resumed.goal, "preserved investigation");
      assert.equal(resumed.artifacts[0].originSessionId, source.id, "historical artifact origin was silently rebased");
      assert.equal((await registry.dispatchCommand(ctx, '/state update 0 {"goal":"stale"}')).status, "failed");
    } finally { await ctx?.shutdown("complete"); await rm(root, { recursive: true, force: true }); }
  });

  it("seeds legacy resume from its original request rather than the next continue prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-task-legacy-")); let ctx;
    try {
      const source = await createSession(null, "fixture", { rootDir: root });
      await saveSessionHistory(source, [{ role: "user", content: "original legacy goal" }, { role: "assistant", content: "partial finding" }], null, "fixture");
      ({ ctx } = await context(root));
      await createDefaultCommandRegistry().dispatchSlashLine(ctx, `/resume ${source.id}`);
      await ctx.runTurn("continue", "fixture");
      assert.equal((await ctx.runtime.task.read()).goal, "original legacy goal");
    } finally { await ctx?.shutdown("complete"); await rm(root, { recursive: true, force: true }); }
  });
});
