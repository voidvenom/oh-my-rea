import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Agent } from "../dist/agent.js";
import { parseArgs } from "../dist/args.js";
import { createDefaultCommandRegistry } from "../dist/runtime.js";
import { OmrContext } from "../dist/runtime/context.js";
import { OutputSink } from "../dist/runtime/output.js";
import { createSession, loadSavedSession, previewSavedSession, saveSessionHistory } from "../dist/session.js";
import { FakeRea } from "../dist/testing/fakes.js";

const makeAgent = () => new Agent({ model: "fixture" }, { definitions: () => [] }, { systemPrompt: "system" });
const call = { id: "valid", type: "function", function: { name: "read_bytes", arguments: "{}" } };

const withContext = async (fn) => {
  const root = await mkdtemp(join(tmpdir(), "omr-session-boundary-"));
  const session = await createSession(null, null, { rootDir: join(root, "sessions") });
  const events = [];
  const ctx = new OmrContext({
    opts: parseArgs(["node", "omr", "--no-model", "--json"]), cwd: root,
    env: { XDG_CONFIG_HOME: join(root, "config") }, sources: [], sessionsRootDir: join(root, "sessions"),
    output: new OutputSink({ json: true, writeStdout: (line) => events.push(JSON.parse(line)), writeStderr: () => {} }),
    session, currentTarget: null, currentMagic: null,
    deps: { connectRea: async (dir) => new FakeRea(dir) },
  });
  try { await fn({ root, ctx, session, events }); }
  finally { await ctx.shutdown("complete"); await rm(root, { recursive: true, force: true }); }
};

describe("B13: saved conversation boundaries validate nested protocol data", () => {
  it("previews a large legacy history and keeps its newest complete exchange in a bounded projection", async () => {
    await withContext(async ({ session, ctx }) => {
      const messages = [
        { role: "user", content: "Initial operator task" },
        ...Array.from({ length: 20 }, () => ({ role: "assistant", content: "ç \\\" ".repeat(50_000) })),
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: "valid", content: "retained result" },
        { role: "assistant", content: "Fresh transcript tail" },
      ];
      const source = JSON.stringify({ title: "Legacy", in_flight: true, messages });
      await writeFile(session.historyPath, source);
      const preview = await previewSavedSession("last", undefined, ctx.sessionsRootDir);
      assert.equal(preview.messages.at(-1).content, "Fresh transcript tail");
      const loaded = await loadSavedSession("last", undefined, ctx.sessionsRootDir);
      assert.equal(loaded.inFlight, true);
      assert.equal(loaded.summary.firstUserPrompt, "Initial operator task");
      assert.ok(loaded.archivedMessages > 0);
      assert.deepEqual(loaded.messages.slice(-3).map((message) => message.role), ["assistant", "tool", "assistant"]);
      assert.equal(loaded.messages.at(-2).content, "retained result");
      assert.equal(await readFile(session.historyPath, "utf8"), source);
    });
  });
  it("drops malformed calls and orphans while preserving valid call/result groups", () => {
    const agent = makeAgent();
    const source = [
      { role: "user", content: "task" },
      { role: "assistant", content: null, tool_calls: { invalid: true } },
      { role: "tool", tool_call_id: "orphan", content: "orphan result" },
      { role: "assistant", content: null, tool_calls: [null] },
      { role: "assistant", content: null, tool_calls: [{ ...call, function: { name: 12, arguments: {} } }] },
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: "valid", content: "verified result" },
      { role: "assistant", content: "answer", thinking_blocks: { invalid: true } },
    ];
    let repair;
    assert.doesNotThrow(() => { repair = agent.restoreHistory(source); });
    assert.equal(repair.droppedMessages, 4);
    assert.deepEqual(agent.history.map((m) => m.role), ["system", "user", "assistant", "tool", "assistant"]);
    assert.equal(agent.history.at(-1).thinking_blocks, undefined);
    assert.doesNotThrow(() => agent.historyChars());
  });

  it("reports malformed messages discarded at the history file boundary", async () => {
    await withContext(async ({ session, ctx }) => {
      await saveSessionHistory(session, [{ role: "user", content: "recover task" }, { role: "assistant", content: "answer" }], null, "fixture");
      const stored = JSON.parse(await readFile(session.historyPath, "utf8"));
      stored.messages.splice(1, 0, { role: "assistant", content: null, tool_calls: { invalid: true } });
      await writeFile(session.historyPath, JSON.stringify(stored));
      const loaded = await loadSavedSession(session.id, undefined, ctx.sessionsRootDir);
      assert.ok(loaded);
      assert.equal(loaded.droppedMessages, 1);
      assert.doesNotThrow(() => makeAgent().restoreHistory(loaded.messages));
    });
  });
});

describe("B17: full forensic exports preserve the start of large reports", () => {
  it("exports the complete Markdown and JSON while keeping view bounded", async () => {
    await withContext(async ({ root, ctx, session, events }) => {
      const ev = `ev_${"ab".repeat(32)}`;
      const report = `EARLY_FINDING ${ev}\n${"later finding\n".repeat(26000)}`;
      await writeFile(session.reportPath, report);
      const registry = createDefaultCommandRegistry();
      const jsonPath = join(root, "report.json");
      await registry.dispatchSlashLine(ctx, `/report json ${jsonPath}`);
      const dossier = JSON.parse(await readFile(jsonPath, "utf8"));
      const hash = (text) => createHash("sha256").update(text).digest("hex");
      assert.equal(hash(dossier.report_markdown), hash(report.trim()));
      assert.ok(dossier.evidence_ids.includes(ev));
      const mdPath = join(root, "report.md");
      await registry.dispatchSlashLine(ctx, `/report export ${mdPath}`);
      assert.ok((await readFile(mdPath, "utf8")).includes(report.trim()));
      await registry.dispatchSlashLine(ctx, "/report view");
      const view = events.findLast((e) => e.type === "command.result" && e.command === "report");
      assert.ok(view.payload.report.length <= 262_144);
    });
  });
});
