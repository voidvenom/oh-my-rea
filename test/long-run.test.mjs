import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Agent } from "../dist/agent.js";
import { UncertainInvocationError } from "../dist/execution.js";
import { LoopGuard } from "../dist/loopGuard.js";
import { ModelClient } from "../dist/model.js";
import { resolveModelConfig } from "../dist/modelConfig.js";
import { describeIncompleteTurn } from "../dist/outcome.js";

/** A turn is unlimited by default and survives what an hours-long run throws at it. */

const toolCall = (id, name = "work", args = "{}") => ({ id, type: "function", function: { name, arguments: args } });
const reply = (over) => ({ content: "", reasoning: "", toolCalls: [], finishReason: "stop", usage: null, reasoningContent: null, thinkingBlocks: [], ...over });
const okBroker = (text = "ok") => ({ definitions: () => [], isReadOnly: () => false, dispatch: async (name) => ({ tool: name, text, isError: false, durationMs: 0, evidenceIds: [] }) });
const roundsModel = (rounds, extra = {}) => {
  let n = 0;
  return {
    model: "fake",
    summarize: async () => "## Goal\nkeep going\n## Observed\n- ev_" + "ab".repeat(32),
    async stream(messages) {
      extra.onRequest?.(messages);
      n += 1;
      return n <= rounds
        ? reply({ toolCalls: [toolCall(`c${n}`, "work", JSON.stringify({ n }))], finishReason: "tool_calls", content: extra.content?.(n) ?? "" })
        : reply({ content: "final answer" });
    },
  };
};

describe("unlimited by default", () => {
  it("ships without a step cap or automatic extensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-long-"));
    try {
      const env = { HOME: dir, OMR_PROVIDER: "custom", OMR_BASE_URL: "http://127.0.0.1:1", OMR_API_KEY: "x", OMR_MODEL: "m" };
      const defaults = resolveModelConfig({ ...env, OMR_CONFIG: join(dir, "none.json") }).config;
      assert.equal(defaults.maxSteps, 0);
      assert.equal(defaults.autoExtendSteps, 0);
      const capped = resolveModelConfig({ ...env, OMR_MAX_STEPS: "25" }).config;
      assert.equal(capped.maxSteps, 25, "explicit opt-in still works");
      assert.equal(capped.autoExtendSteps, 0, "opting in to a cap does not opt in to extensions");
      assert.equal(resolveModelConfig({ ...env, OMR_MAX_STEPS: "25", OMR_AUTO_EXTEND_STEPS: "2" }).config.autoExtendSteps, 2);
      assert.equal(resolveModelConfig({ ...env, OMR_MAX_STEPS: "0" }).config.maxSteps, 0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("runs 800 tool rounds with no options set and ends only on the final answer", async () => {
    const turn = await new Agent(roundsModel(800), okBroker(), { systemPrompt: "sys" }).run("go");
    assert.equal(turn.status, "completed");
    assert.equal(turn.toolCalls, 800);
    assert.equal(turn.text, "final answer");
  });

  it("an explicit cap is still honoured and says which setting controls it", async () => {
    const turn = await new Agent(roundsModel(1000), okBroker(), { systemPrompt: "sys", maxSteps: 5 }).run("go");
    assert.equal(turn.status, "partial");
    assert.equal(turn.finishReason, "step_budget");
    assert.match(describeIncompleteTurn(turn.finishReason), /OMR_MAX_STEPS/);
  });

  it("loop guard only nudges: identical calls keep executing and the turn is never ended", async () => {
    let executed = 0;
    let n = 0;
    const model = { model: "fake", summarize: async () => "s", async stream() { n += 1; return n <= 50 ? reply({ toolCalls: [toolCall(`c${n}`, "same", '{"a":1}')], finishReason: "tool_calls" }) : reply({ content: "done" }); } };
    const broker = { definitions: () => [], isReadOnly: () => true, dispatch: async (name) => { executed += 1; return { tool: name, text: "same data", isError: false, durationMs: 0, evidenceIds: [] }; } };
    const agent = new Agent(model, broker, { systemPrompt: "sys" });
    const turn = await agent.run("go");
    assert.equal(turn.status, "completed");
    assert.equal(executed, 50);
    assert.ok(agent.history.some((m) => m.role === "tool" && /loop guard/.test(m.content ?? "")), "the model is warned");
  });

  it("the loop guard's memory stays bounded over an unbounded turn", () => {
    const guard = new LoopGuard();
    for (let i = 0; i < 20_000; i += 1) guard.record("omr_run", { code: `echo ${i}`.repeat(50) }, false, true);
    assert.ok(guard.seen.size <= 4096, `retained ${guard.seen.size} signatures`);
  });
});

describe("a long turn survives context pressure", () => {
  const compactionSettings = (over = {}) => () => ({ strategy: "context-full", thresholdPercent: 50, keepRecentTokens: 1500, contextWindow: 20_000, ...over });

  it("auto-compacts repeatedly while a 300-round turn produces far more output than the window holds", async () => {
    let peak = 0;
    let agent;
    const model = roundsModel(300, { onRequest: () => { peak = Math.max(peak, agent.contextUsage().tokens); } });
    agent = new Agent(model, okBroker("y".repeat(6000)), { systemPrompt: "sys", compaction: compactionSettings() });
    const reports = [];
    const turn = await agent.run("find the gate", { onCompaction: (r) => reports.push(r) });
    assert.equal(turn.status, "completed");
    assert.equal(turn.toolCalls, 300);
    assert.ok(300 * 6000 / 4 > 20_000 * 10, "the turn's tool output exceeds the window many times over");
    assert.ok(reports.length >= 3, `compacted ${reports.length} times`);
    assert.ok(peak <= 20_000, `context peaked at ${peak} of 20000`);
    agent.history.forEach((m, i) => { if (m.role === "tool") assert.ok(agent.history[i - 1].tool_calls?.some((c) => c.id === m.tool_call_id) || agent.history[i - 1].role === "tool"); });
  });

  it("when summarizing fails and nothing can be stubbed, sheds the oldest exchanges instead of ending the turn", async () => {
    let peak = 0;
    let agent;
    const traces = [];
    // Large assistant prose cannot be stubbed by shake, and the summarizer is down: only the emergency trim can help.
    const model = { ...roundsModel(120, { content: () => "reasoning ".repeat(700), onRequest: () => { peak = Math.max(peak, agent.contextUsage().tokens); } }), summarize: async () => { throw new Error("summarizer offline"); } };
    agent = new Agent(model, okBroker("small"), { systemPrompt: "sys", compaction: compactionSettings({ contextWindow: 16_000 }), trace: async (name) => { traces.push(name); } });
    const turn = await agent.run("find the gate");
    assert.equal(turn.status, "completed", `${turn.status} ${turn.finishReason}: ${turn.text.slice(0, 200)}`);
    assert.equal(turn.toolCalls, 120);
    assert.ok(traces.includes("context.emergency-trim"), "emergency trim ran");
    assert.ok(peak <= 16_000, `context peaked at ${peak}`);
  });
});

describe("tool failures and aborts", () => {
  it("returns errors for empty and truncated tool arguments without dispatching them", async () => {
    let round = 0;
    const model = {
      model: "fake",
      async stream() {
        round += 1;
        return round <= 2
          ? reply({ toolCalls: [toolCall(`c${round}`, "work", round === 1 ? "" : '{"value":')], finishReason: "tool_calls" })
          : reply({ content: "recovered" });
      },
    };
    const broker = { ...okBroker(), dispatch: async () => assert.fail("incomplete arguments were dispatched") };
    const agent = new Agent(model, broker, { systemPrompt: "sys" });
    const turn = await agent.run("go");
    assert.equal(turn.status, "completed");
    const results = agent.history.filter((message) => message.role === "tool");
    assert.equal(results.length, 2);
    for (const result of results) assert.match(result.content, /Invalid tool arguments JSON/);
  });

  it("a tool whose outcome is uncertain or that throws is reported to the model; the turn continues", async () => {
    let n = 0;
    const model = { model: "fake", summarize: async () => "s", async stream() { n += 1; return n <= 3 ? reply({ toolCalls: [toolCall(`c${n}`, `t${n}`)], finishReason: "tool_calls" }) : reply({ content: "recovered" }); } };
    const broker = { definitions: () => [], isReadOnly: () => false, dispatch: async (name) => {
      if (name === "t1") throw new UncertainInvocationError("inv-1", new Error("tool timeout"));
      if (name === "t2") throw new Error("MCP request timed out");
      return { tool: name, text: "ok", isError: false, durationMs: 0, evidenceIds: [] };
    } };
    const agent = new Agent(model, broker, { systemPrompt: "sys" });
    const turn = await agent.run("go");
    assert.equal(turn.status, "completed");
    assert.equal(turn.text, "recovered");
    const results = agent.history.filter((m) => m.role === "tool").map((m) => m.content);
    assert.match(results[0], /uncertain outcome/);
    assert.match(results[1], /MCP request timed out/);
  });

  it("aborts instantly even when the running tool ignores the abort signal", async () => {
    let n = 0;
    const model = { model: "fake", summarize: async () => "s", async stream() { n += 1; return reply({ toolCalls: [toolCall(`c${n}`, "hang")], finishReason: "tool_calls" }); } };
    const broker = { definitions: () => [], isReadOnly: () => false, dispatch: () => new Promise(() => {}) };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const started = Date.now();
    const turn = await new Agent(model, broker, { systemPrompt: "sys" }).run("go", {}, controller.signal);
    assert.equal(turn.status, "cancelled");
    assert.equal(turn.aborted, true);
    assert.ok(Date.now() - started < 1000, `abort took ${Date.now() - started}ms`);
  });
});

const sseServer = async (script, fn) => {
  let round = 0;
  const server = createServer((req, res) => { req.resume(); req.on("end", () => script(round++, res)); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { await fn(server.address().port); }
  finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
};
const clientAt = (port, over = {}) => new ModelClient({
  providerId: "custom", protocol: "openai-chat", baseUrl: `http://127.0.0.1:${port}`, model: "m", apiKey: "k", apiKeyEnv: "T",
  maxTokens: 500, temperature: null, maxSteps: 0, timeoutMs: 5000, capabilities: { contextWindow: 100_000, maxOutputTokens: 500 }, ...over,
});
const answer = (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`); };

describe("provider interruptions", () => {
  it("retries 429 / 5xx / dropped sockets with backoff and finishes the same turn", async () => {
    const faults = [
      (res) => { res.writeHead(429, { "retry-after-ms": "5" }); res.end('{"error":{"message":"rate limited"}}'); },
      (res) => { res.writeHead(503, { "retry-after-ms": "5" }); res.end('{"error":{"message":"overloaded"}}'); },
      (res) => { res.writeHead(502, { "retry-after-ms": "5" }); res.end("bad gateway"); },
      (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" } }] })}\n\n`); setTimeout(() => res.destroy(), 10); },
    ];
    await sseServer((round, res) => (round < faults.length ? faults[round](res) : answer(res)), async (port) => {
      const retries = [];
      const turn = await new Agent(clientAt(port), okBroker(), { systemPrompt: "sys" }).run("go", { onRetry: (n) => retries.push(n.reason) });
      assert.equal(turn.status, "completed");
      assert.equal(turn.text, "ok");
      assert.ok(retries.length >= 3, `retries seen: ${retries.join(" | ")}`);
    });
  });

  it("a stalled stream is retried (not fatal) and the stall detector can be disabled with timeoutMs=0", async () => {
    await sseServer((round, res) => (round === 0 ? (res.writeHead(200, { "content-type": "text/event-stream" }), res.write(": keepalive\n\n")) : answer(res)), async (port) => {
      const turn = await new Agent(clientAt(port, { timeoutMs: 1000 }), okBroker(), { systemPrompt: "sys" }).run("go", { onRetry: () => {} });
      assert.equal(turn.status, "completed");
    });
    assert.equal(resolveModelConfig({ HOME: tmpdir(), OMR_PROVIDER: "custom", OMR_BASE_URL: "http://127.0.0.1:1", OMR_API_KEY: "x", OMR_MODEL: "m", OMR_TIMEOUT_MS: "0" }).config.timeoutMs, 0);
  });

  it("retries heartbeat-only streams and finishes at DONE before the server closes the connection", async () => {
    let requests = 0;
    await sseServer((round, res) => {
      requests += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (round === 0) {
        res.write(": keepalive\n\n");
        const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 50);
        res.once("close", () => clearInterval(heartbeat));
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`);
      }
    }, async (port) => {
      const deadline = AbortSignal.timeout(5000);
      const turn = await new Agent(clientAt(port, { timeoutMs: 1000 }), okBroker(), { systemPrompt: "sys" }).run("go", {}, deadline);
      assert.equal(turn.status, "completed");
      assert.equal(turn.text, "ok");
      assert.equal(requests, 2);
    });
  });

  it("aborts instantly while the model is still thinking", async () => {
    await sseServer((_round, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking forever" } }] })}\n\n`); }, async (port) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 150);
      const started = Date.now();
      const turn = await new Agent(clientAt(port, { timeoutMs: 0 }), okBroker(), { systemPrompt: "sys" }).run("go", {}, controller.signal);
      assert.equal(turn.status, "cancelled");
      assert.ok(Date.now() - started < 1000, `abort took ${Date.now() - started}ms`);
    });
  });
});
