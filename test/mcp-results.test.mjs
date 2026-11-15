import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Rea } from "../dist/rea.js";
import { ReaBroker } from "../dist/broker.js";

const withRea = async (fn) => {
  const root = await mkdtemp(join(tmpdir(), "omr-mcp-results-"));
  let rea;
  try {
    rea = await Rea.connect(root, {PATH: process.env.PATH, OMR_REA_COMMAND: fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url)), OMR_FIXTURE_MODE: "normal"}, []);
    await fn(rea);
  } finally { await rea?.close(); await rm(root, {recursive: true, force: true}); }
};

describe("B10: lossless MCP result normalization", () => {
  it("uses structured-only output and preserves explicit/REA envelope errors", async () => {
    await withRea(async (rea) => {
      const structured = {value: 42, evidence_id: `ev_${"a".repeat(64)}`};
      const result = await rea.call("fixture_echo", {__fixture_result: {content: [], structuredContent: structured}});
      assert.deepEqual(result.payload, structured);
      assert.deepEqual(result.structuredContent, structured);
      assert.match(result.text, /42/);
      const error = await rea.call("fixture_echo", {__fixture_result: {content: [], isError: true, structuredContent: {error: {message: "failed fixture"}}}});
      assert.equal(error.isError, true);
      assert.match(error.text, /failed fixture/);
      assert.deepEqual(error.payload, {__error: {message: "failed fixture"}});
    });
  });

  it("retains mixed blocks and passes images, resource text and structured evidence to the broker", async () => {
    await withRea(async (rea) => {
      const content = [
        {type: "text", text: "caption"},
        {type: "image", mimeType: "image/png", data: "cGl4ZWxz"},
        {type: "resource", resource: {uri: "fixture://code", mimeType: "text/plain", text: "embedded source"}},
        {type: "resource_link", name: "artifact", uri: "fixture://artifact"},
        {type: "audio", mimeType: "audio/wav", data: "YXVkaW8="},
      ];
      const wire = {content, structuredContent: {evidence_id: `ev_${"b".repeat(64)}`, value: 43}};
      const result = await rea.call("fixture_echo", {__fixture_result: wire});
      assert.deepEqual(result.content, content);
      assert.equal(result.images[0].data, "cGl4ZWxz");
      assert.match(result.text, /embedded source/);
      assert.match(result.text, /fixture:\/\/artifact/);
      assert.match(result.text, /43/);
      assert.doesNotMatch(result.text, /cGl4ZWxz|YXVkaW8=/);
      const outcome = await new ReaBroker(rea).dispatch("fixture_echo", {__fixture_result: wire});
      assert.equal(outcome.images[0].mimeType, "image/png");
      assert.ok(outcome.evidenceIds.includes(`ev_${"b".repeat(64)}`));
      assert.deepEqual(outcome.content, content);
    });
  });
});
