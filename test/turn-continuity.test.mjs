import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Agent } from "../dist/agent.js";
import { LIVE_LOOP_LIMIT, LoopGuard } from "../dist/loopGuard.js";
import { ModelClient } from "../dist/model.js";
import { resolveModelConfig } from "../dist/modelConfig.js";

/**
 * A turn must only end on a final answer, a user abort, or an unrecoverable error.
 * These tests drive the real ModelClient + Agent against a local OpenAI-compatible SSE server that
 * emulates DeepSeek-style behaviour (reasoning_content, no usage, finish_reason quirks).
 */

const sseWrite = (res, chunks) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) res.write(`data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`);
  res.end();
};
const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

/** `script(round, body)` returns SSE chunks (or a function(res) for raw control). */
const withServer = async (script, fn) => {
  let round = 0;
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push(body);
      const out = script(round++, body);
      if (typeof out === "function") out(res);
      else sseWrite(res, out);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { await fn(server.address().port, requests); }
  finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
};

const clientAt = (port, timeoutMs = 5000) => new ModelClient({
  providerId: "custom", protocol: "openai-chat", baseUrl: `http://127.0.0.1:${port}`, model: "DeepSeek-V4.1-Flash",
  apiKey: "fixture", apiKeyEnv: "TEST", maxTokens: 1000, temperature: null, maxSteps: 40, timeoutMs,
  capabilities: { contextWindow: 100_000, maxOutputTokens: 1000 },
});

/** One DeepSeek-style tool round: reasoning first, then a call whose JSON arrives in pieces. */
const toolRound = (n, name = "omr_run", finish = "tool_calls") => [
  delta({ reasoning_content: `thinking about step ${n}` }),
  delta({ tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name, arguments: "" } }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: `{"code":"echo ${n}"` } }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish),
  "[DONE]",
];
const finalAnswer = [delta({ reasoning_content: "done thinking" }), delta({ content: "final answer" }, "stop"), "[DONE]"];

/** Broker whose tools succeed but never produce REA Evidence (shell / browser work). */
const quietBroker = () => ({
  definitions: () => [],
  isReadOnly: () => false,
  dispatch: async (name) => ({ tool: name, text: "ok", isError: false, durationMs: 1, evidenceIds: [] }),
});

describe("turn continuity: a turn only ends on a final answer, abort or unrecoverable error", () => {
  it("finishes a 70-round tool turn with the shipped step defaults (no REA Evidence produced)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-cont-"));
    try {
      const info = resolveModelConfig({ HOME: dir, OMR_CONFIG: join(dir, "none.json"), OMR_PROVIDER: "custom", OMR_BASE_URL: "http://127.0.0.1:1", OMR_API_KEY: "x", OMR_MODEL: "m" });
      const cfg = info.config;
      await withServer((round) => (round < 70 ? toolRound(round) : finalAnswer), async (port, requests) => {
        const agent = new Agent(clientAt(port), quietBroker(), {
          systemPrompt: "sys", maxSteps: cfg.maxSteps, autoExtendSteps: cfg.autoExtendSteps, progressEpoch: () => 0,
        });
        const turn = await agent.run("go");
        assert.equal(turn.status, "completed", `ended early: ${turn.status} (${turn.finishReason}) after ${turn.steps} steps: ${turn.text.slice(-200)}`);
        assert.equal(turn.text, "final answer");
        assert.equal(turn.toolCalls, 70);
        assert.equal(requests.length, 71);
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("when the hard step cap is hit the turn says why, names the setting, and is not labelled tool_calls", async () => {
    await withServer((round) => toolRound(round), async (port) => {
      const agent = new Agent(clientAt(port), quietBroker(), { systemPrompt: "sys", maxSteps: 3, autoExtendSteps: 1 });
      const turn = await agent.run("go");
      assert.equal(turn.status, "partial");
      assert.equal(turn.finishReason, "step_budget");
      assert.match(turn.text, /OMR_MAX_STEPS/);
      assert.match(turn.text, /OMR_AUTO_EXTEND_STEPS/);
    });
  });

  it("treats a missing finish_reason with tool calls as tool_calls and keeps going", async () => {
    await withServer((round) => (round < 3 ? toolRound(round, "omr_run", null) : finalAnswer), async (port) => {
      const turn = await new Agent(clientAt(port), quietBroker(), { systemPrompt: "sys", maxSteps: 10 }).run("go");
      assert.equal(turn.status, "completed");
      assert.equal(turn.toolCalls, 3);
    });
  });

  it("accepts legacy / variant tool finish reasons (function_call, tool_call)", async () => {
    for (const reason of ["function_call", "tool_call"]) {
      await withServer((round) => (round < 2 ? toolRound(round, "omr_run", reason) : finalAnswer), async (port) => {
        const turn = await new Agent(clientAt(port), quietBroker(), { systemPrompt: "sys", maxSteps: 10 }).run("go");
        assert.equal(turn.status, "completed", reason);
        assert.equal(turn.toolCalls, 2, reason);
      });
    }
  });

  it("recovers from finish_reason=tool_calls with no usable tool call instead of stopping", async () => {
    const empty = [delta({ reasoning_content: "hmm" }), delta({ content: "" }, "tool_calls"), "[DONE]"];
    await withServer((round) => (round === 1 ? empty : round < 4 ? toolRound(round) : finalAnswer), async (port) => {
      const turn = await new Agent(clientAt(port), quietBroker(), { systemPrompt: "sys", maxSteps: 10 }).run("go");
      assert.equal(turn.status, "completed", `${turn.status} (${turn.finishReason})`);
      assert.equal(turn.text, "final answer");
    });
  });

  it("recovers from output truncated by max_tokens (finish_reason=length) mid tool call", async () => {
    const cut = [
      delta({ reasoning_content: "long thinking" }),
      delta({ tool_calls: [{ index: 0, id: "call_cut", type: "function", function: { name: "omr_run", arguments: '{"code":"ec' } }] }, "length"),
      "[DONE]",
    ];
    await withServer((round) => (round === 1 ? cut : round < 3 ? toolRound(round) : finalAnswer), async (port, requests) => {
      const turn = await new Agent(clientAt(port), quietBroker(), { systemPrompt: "sys", maxSteps: 10 }).run("go");
      assert.equal(turn.status, "completed", `${turn.status} (${turn.finishReason})`);
      assert.equal(turn.text, "final answer");
      // The truncated call must never be replayed to the provider as a dangling tool_call.
      const replay = requests.at(-1).messages;
      for (const m of replay) if (m.tool_calls) assert.ok(!m.tool_calls.some((c) => c.id === "call_cut"));
    });
  });

  it("auto-resumes after a stream is cut, stalls, or errors mid-stream once reasoning was already streamed", async () => {
    const reasoningChunk = `data: ${JSON.stringify(delta({ reasoning_content: "thinking, then the provider fails" }))}\n\n`;
    const variants = {
      "socket reset": (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(reasoningChunk); setTimeout(() => res.destroy(), 20); },
      "idle stall": (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(reasoningChunk); /* never ends */ },
      "SSE overloaded error": (res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(reasoningChunk); res.end(`data: ${JSON.stringify({ error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`); },
    };
    for (const [label, bad] of Object.entries(variants)) {
      await withServer((round) => (round === 1 ? bad : round < 3 ? toolRound(round) : finalAnswer), async (port) => {
        const client = clientAt(port, label === "idle stall" ? 400 : 5000);
        const resets = [];
        const turn = await new Agent(client, quietBroker(), { systemPrompt: "sys", maxSteps: 10 }).run("go", { onStreamReset: () => resets.push(1), onRetry: () => {} });
        assert.equal(turn.status, "completed", `${label}: ${turn.status} ${turn.text}`);
        assert.equal(turn.text, "final answer", label);
        assert.ok(resets.length >= 1, `${label}: partial output must be reset before the re-request`);
      });
    }
  });

  it("does not trip the loop guard on repeated rea_call/camofox_evaluate with different expressions", () => {
    const guard = new LoopGuard();
    for (let i = 0; i < 60; i += 1) {
      const args = { name: "camofox_evaluate", arguments: { tabId: "t1", expression: `document.title + ${i}` } };
      assert.equal(guard.check("rea_call", args, true), null, `call ${i}`);
      guard.record("rea_call", args, true, false);
    }
    // Identical live-state polling is tolerated up to LIVE_LOOP_LIMIT, then caught.
    const same = { name: "camofox_evaluate", arguments: { tabId: "t1", expression: "1" } };
    for (let i = 0; i < LIVE_LOOP_LIMIT; i += 1) { assert.equal(guard.check("rea_call", same, true), null, `poll ${i}`); guard.record("rea_call", same, true, false); }
    assert.match(guard.check("rea_call", same, true) ?? "", /loop guard/);
    // Session-deterministic REA reads are still caught on the third identical call.
    const decompile = { name: "procedure_pseudo_code", arguments: { procedure: "main" } };
    for (let i = 0; i < 2; i += 1) { assert.equal(guard.check("rea_call", decompile, true), null); guard.record("rea_call", decompile, true, false); }
    assert.match(guard.check("rea_call", decompile, true) ?? "", /loop guard/);
  });
});
