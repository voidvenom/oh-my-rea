// Controlled stdio peer for transport lifecycle/contract tests; never contacts external services.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

if (process.env.OMR_FIXTURE_PID_FILE) {
  writeFileSync(process.env.OMR_FIXTURE_PID_FILE, String(process.pid));
}
const mode = process.env.OMR_FIXTURE_MODE ?? "catalog-error";
if (mode === "normal-descendant") {
  const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});
  writeFileSync(process.env.OMR_FIXTURE_DESC_PID_FILE,String(child.pid));
}
const changing = mode === "catalog-change";
let generation = 0, listRequests = 0, failNextList = false, effectCalls = 0;
const send = reply => process.stdout.write(`${JSON.stringify(reply)}\n`);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (mode === "quiet-init" && request.method === "initialize") return;
  const reply = { jsonrpc: "2.0", id: request.id };
  if (request.method === "initialize") {
    reply.result = {
      protocolVersion: changing ? "2025-11-25" : request.params.protocolVersion,
      capabilities: { tools: changing ? { listChanged: true } : {}, ...(changing ? { prompts: { listChanged: true } } : {}) },
      serverInfo: { name: "omr-test-fixture", version: "1.0" },
    };
  } else if (request.method === "tools/list") {
    listRequests++;
    if (changing) {
      if (failNextList) { failNextList = false; reply.error = { code: -32603, message: "controlled refresh failure" }; }
      else if (request.params?.cursor === "page2") reply.result = { tools: [{ name: generation ? "fixture_new" : "fixture_old", description: "Second catalog page", inputSchema: { type: "object" } }] };
      else reply.result = { tools: [
        { name: "fixture_control", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
        { name: "open_binary", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
        { name: "fixture_same", description: `Schema generation ${generation}`, inputSchema: { type: "object", properties: { value: { type: generation ? "integer" : "string" } }, required: ["value"] }, annotations: { readOnlyHint: generation === 0 } },
      ], nextCursor: "page2" };
      if (generation) { setTimeout(() => send(reply), 20); return; }
    } else if (mode === "normal" || mode === "normal-descendant") {
      reply.result = { tools: [{ name: "fixture_echo", description: "Local fixture echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] };
    } else {
      reply.error = { code: -32603, message: "controlled catalog failure" };
    }
  } else if (request.method === "tools/call") {
    if (changing && request.params.name === "fixture_control") {
      if (request.params.arguments.action === "change") {
        generation++; failNextList = request.params.arguments.fail === true;
        for (let index = 0; index < 3; index++) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        send({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" });
      }
      reply.result = { content: [], structuredContent: { generation, listRequests, effectCalls } };
    } else {
      effectCalls++;
      reply.result = request.params.arguments.__fixture_result ?? { content: [{ type: "text", text: JSON.stringify({ result: request.params.arguments }) }] };
    }
  } else if (request.method === "prompts/list" && changing) {
    reply.result = { prompts: [{ name: `prompt_${generation}`, description: "Changing fixture prompt" }] };
  } else {
    reply.result = {};
  }
  if (request.method === "tools/call" && process.env.OMR_FIXTURE_TOOL_DELAY) setTimeout(()=>send(reply),Number(process.env.OMR_FIXTURE_TOOL_DELAY)); else send(reply);
});
