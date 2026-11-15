import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const mode = process.argv[2], options = JSON.parse(process.argv[3] ?? "{}");
const root = await mkdtemp(join(tmpdir(), "omr-benchmark-"));
const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error("Benchmark worker deadline")), 50_000); timer.unref();
process.once("SIGTERM", () => controller.abort(new Error("Benchmark worker terminated")));
let runtime, rea, server, report;
const clock = () => performance.now();
const elapsed = start => clock() - start;
const childRss = async pid => { try { const text = await readFile(`/proc/${pid}/status`, "utf8"); return Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(text)?.[1]) || null; } catch { return null; } };
const memory = () => ({ maxRssKiB: process.resourceUsage().maxRSS, rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed });
const makeRuntime = async directory => {
  const [{ createSession }, { SessionRuntime }] = await Promise.all([import("../dist/session.js"), import("../dist/runtime/sessionRuntime.js")]);
  const session = await createSession(null, null, { rootDir: directory });
  return new SessionRuntime(session, { PATH: process.env.PATH }, () => ({ cancelAll: async () => {} }));
};
try {
  if (mode === "import") {
    const start = clock(); await import("../dist/runtime/context.js"); report = { importMs: elapsed(start), memory: memory() };
  } else if (mode === "mcp" || mode === "catalog") {
    const { Rea } = await import("../dist/rea.js"); runtime = await makeRuntime(root);
    const env = { PATH: process.env.PATH, ...(options.real ? (process.env.OMR_REA_COMMAND ? { OMR_REA_COMMAND: process.env.OMR_REA_COMMAND } : {}) : { OMR_REA_COMMAND: fileURLToPath(new URL("../test/fixtures/mcp-server.mjs", import.meta.url)), OMR_FIXTURE_MODE: "normal" }) };
    const start = clock(); rea = await Rea.connect(runtime.session.dir, env, [], { signal: controller.signal }); const connectMs = elapsed(start);
    runtime.attachRea(rea);
    if (mode === "catalog") {
      const text = JSON.stringify(rea.tools()); await writeFile(options.path, text);
      report = { connectMs, catalogCount: rea.tools().length, catalogBytes: Buffer.byteLength(text), catalogSha256: createHash("sha256").update(text).digest("hex"), nativeChildRssKiB: await childRss(rea.processId), memory: memory() };
    } else {
      const tool = options.real ? "binary_session" : "fixture_echo", args = options.real ? { detail: "summary" } : { message: "benchmark" };
      const first = clock(); const firstResult = await rea.call(tool, args, { signal: controller.signal }); assert.equal(firstResult.isError, false, firstResult.text); const firstToolMs = elapsed(first);
      const rawMs = [], durableMs = [];
      for (let index = 0; index < 12; index++) { const start = clock(); assert.equal((await rea.call(tool, args, { signal: controller.signal })).isError, false); rawMs.push(elapsed(start)); }
      for (let index = 0; index < 12; index++) { const start = clock(); assert.equal((await runtime.rea.call(tool, args, { signal: controller.signal })).isError, false); durableMs.push(elapsed(start)); }
      report = { connectMs, firstToolMs, rawMs, durableMs, responseBytes: Buffer.byteLength(firstResult.text), catalogCount: rea.tools().length, nativeChildRssKiB: await childRss(rea.processId), memory: memory() };
    }
  } else if (mode === "broker") {
    const [{ ReaBroker }, { createFakeCatalog }, { estimateToolTokens }] = await Promise.all([import("../dist/broker.js"), import("../dist/testing/fakes.js"), import("../dist/capabilities.js")]);
    const catalog = options.path ? JSON.parse(await readFile(options.path,"utf8")) : createFakeCatalog(); const map = new Map(catalog.map(tool => [tool.name,tool]));
    runtime = await makeRuntime(root);
    const port = { sessionDir: runtime.session.dir, isClosed: false, catalogRevision: 1, envSources: [], tools: () => catalog, find: name => map.get(name), close: async () => {}, diagnostics: () => "", prompts: async () => [], getPrompt: async () => "", call: async () => { throw new Error("unused"); } };
    const cases = [];
    for (const context of [{ targetPath: "/fixture/sample.elf", targetFormat: "ELF" }, { targetPath: "/fixture/app.apk", targetFormat: "Android APK" }, { targetPath: "/fixture/app.js", targetFormat: "JavaScript" }]) {
      const coldMs = [], warmMs = []; let definitions;
      for (let trial = 0; trial < 10; trial++) {
        const broker = new ReaBroker(port, { localTools: () => runtime.localTools() }); const start = clock(); definitions = broker.definitions(context); coldMs.push(elapsed(start));
        for (let repeat = 0; repeat < 30; repeat++) { const start = clock(); const current = broker.definitions(context); assert.equal(current.length, definitions.length); warmMs.push(elapsed(start)); }
      }
      cases.push({ route: context.targetFormat, definitionCount: definitions.length, schemaBytes: Buffer.byteLength(JSON.stringify(definitions)), estimatedSchemaTokens: estimateToolTokens(definitions), coldMs, warmMs });
    }
    const full = catalog.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
    report = { catalogCount: catalog.length, fullSchemaBytes: Buffer.byteLength(JSON.stringify(full)), fullEstimatedSchemaTokens: estimateToolTokens(full), cases, memory: memory() };
  } else if (mode === "model") {
    const [{ ModelClient }, { resolveModelConfig }, { UsageLedger, BudgetModelClient }] = await Promise.all([import("../dist/model.js"), import("../dist/modelConfig.js"), import("../dist/usage.js")]);
    server = createServer(async (req,res) => {
      for await (const _chunk of req) {};
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      await delay(10); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "fixture" }, finish_reason: null }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 } })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
    const config = resolveModelConfig({ XDG_CONFIG_HOME: root, OMR_BASE_URL: `http://127.0.0.1:${server.address().port}`, OMR_API_KEY: "fixture", OMR_MODEL: "gpt-4.1", OMR_MAX_TOKENS: "64", OMR_REASONING_EFFORT: "off", OMR_NET_WAIT_MS: "0", OMR_PING_INTERVAL_MS: "0" }).config;
    assert.match(config.baseUrl, /^http:\/\/127\.0\.0\.1:/);
    const raw = new ModelClient(config); const ledger = new UsageLedger(root); const budgeted = new BudgetModelClient(raw, ledger, "benchmark"); const samples = [];
    for (const [label, client] of [["raw",raw],["durable-usage",budgeted]]) for (let index = 0; index < options.samples; index++) {
      const start = clock(); let first = null; const result = await client.stream([{ role: "user", content: "controlled fixture" }], [], controller.signal, () => { first ??= elapsed(start); });
      assert.equal(result.content,"fixture"); samples.push({ mode: label, ttftMs: first, totalMs: elapsed(start), reportedFixtureTokens: result.usage.total_tokens });
    }
    report = { serverFirstDeltaDelayMs: 10, transport: "loopback SSE", samples, usage: ledger.snapshot(), memory: memory() };
  } else if (mode === "context") {
    const [{ TaskStateStore }, { Agent }, { DEFAULT_COMPACTION_SETTINGS }, { estimateRequestTokens }, { ContextArchive }] = await Promise.all([import("../dist/taskState.js"), import("../dist/agent.js"), import("../dist/compaction.js"), import("../dist/capabilities.js"), import("../dist/contextArchive.js")]);
    const task = new TaskStateStore(root); await task.initializeGoal("Goal ".repeat(60_000));
    const noteMs = []; for (let repeat = 0; repeat < 200; repeat++) { const start = clock(); const note = task.contextNote(); assert.ok(note.length < 8500); noteMs.push(elapsed(start)); }
    const archive = new ContextArchive(root,"benchmark");
    const agent = new Agent({ model: "vision-fixture" }, { definitions: () => [], dispatch: async () => { throw new Error("unused"); } }, { systemPrompt: "fixture", archiveProjection: input => archive.project(input), compaction: () => ({ ...DEFAULT_COMPACTION_SETTINGS, strategy: "snapcompact", keepRecentTokens: 20, contextWindow: 1_000_000, contextWindowExplicit: true }) });
    const rounds = [];
    for (let round = 0; round < 8; round++) {
      agent.history.push({ role: "user", content: `request ${round}` }, { role: "assistant", content: `Evidence round ${round}: ${"observable facts in the fixture. ".repeat(1000)}` }, { role: "user", content: `tail ${round}` });
      const start = clock(); await agent.compactWith("snapcompact", "");
      const images = agent.history.flatMap(message => message.images ?? []);
      rounds.push({ round: round + 1, compactionMs: elapsed(start), frames: images.length, pngBytes: images.reduce((sum,image) => sum + Buffer.from(image.data,"base64").length,0), estimatedRequestTokens: estimateRequestTokens(agent.history), serializedContextBytes: Buffer.byteLength(JSON.stringify(agent.history)) });
    }
    report = { taskGoalChars: (await task.read()).goal.length, taskNoteMs: noteMs, compactionRounds: rounds, archiveMode: "runtime durable bounded projection", memory: memory() };
  } else if (mode === "replay") {
    const { ExecutionStore } = await import("../dist/execution.js"); const { ProgressTracker } = await import("../dist/progress.js");
    await copyFile(options.path,join(root,"execution.jsonl"));
    globalThis.gc?.(); const before = memory(); const start = clock(); const store = new ExecutionStore("fixture",root); new ProgressTracker("fixture",store); await store.initialize();
    report = { records: options.records, bytes: (await stat(options.path)).size, replayMs: elapsed(start), memoryBefore: before, memory: memory() };
  } else throw new Error(`Unknown benchmark mode ${mode}`);
} finally {
  clearTimeout(timer); const errors=[];
  try { await runtime?.close(); } catch(error) {errors.push(error);}
  try { if(rea&&!rea.isClosed)await rea.close(); } catch(error) {errors.push(error);}
  try { if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));} } catch(error) {errors.push(error);}
  try { await rm(root,{recursive:true,force:true}); } catch(error) {errors.push(error);}
  if(errors.length)throw new AggregateError(errors,"Benchmark cleanup failed");
}
console.log(JSON.stringify(report));
