import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_COMPACTION_SETTINGS } from "../dist/compaction.js";
import { ModelController } from "../dist/runtime/modelController.js";
import { OutputSink } from "../dist/runtime/output.js";

const withController = async (fn) => {
  const root = await mkdtemp(join(tmpdir(), "omr-model-life-"));
  const attempts = [];
  const created = [];
  const controller = new ModelController({
    XDG_CONFIG_HOME: root,
    OPENAI_API_KEY: "fake",
    OMR_MODEL: "gpt-4.1",
    OMR_FALLBACK_MODELS: "openai:gpt-4o",
  }, false, null, new OutputSink({ json: true, writeStdout: () => {}, writeStderr: () => {} }), {
    getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
    setCompactionSettings: () => {},
    onModelUpdated: async () => {},
  }, (config) => {
    created.push(config);
    return {
      model: config.model,
      stream: async () => {
        attempts.push(config.model);
        if (config.model === "gpt-4.1") throw new Error("controlled quota failure");
        return { content: "done", reasoning: "", toolCalls: [], finishReason: "stop", usage: null, reasoningContent: null, thinkingBlocks: [] };
      },
      summarize: async () => "summary",
    };
  });
  try { await fn({ controller, attempts, created }); }
  finally { await rm(root, { recursive: true, force: true }); }
};

describe("B12: provider compatibility and failover survive turn boundaries", () => {
  it("reuses the client chain for unchanged and equivalent configurations", async () => {
    await withController(async ({ controller, created }) => {
      const first = controller.buildActiveClient();
      assert.equal(controller.buildActiveClient(), first);
      controller.modelInfo = { ...controller.modelInfo, config: { ...controller.modelInfo.config } };
      assert.equal(controller.buildActiveClient(), first);
      assert.equal(created.length, 2);
    });
  });

  it("keeps the successful fallback active on the next turn", async () => {
    await withController(async ({ controller, attempts }) => {
      await controller.buildActiveClient().stream([], [], undefined, () => {});
      await controller.buildActiveClient().stream([], [], undefined, () => {});
      assert.deepEqual(attempts, ["gpt-4.1", "gpt-4o", "gpt-4o"]);
    });
  });

  it("invalidates the chain when request settings change", async () => {
    await withController(async ({ controller, created }) => {
      const first = controller.buildActiveClient();
      controller.applyEffortSelection("high", false);
      const second = controller.buildActiveClient();
      assert.notEqual(second, first);
      assert.equal(created.at(-2).reasoningEffort, "high");
      controller.modelInfo.config.headers = { ...controller.modelInfo.config.headers, "x-audit-header": "changed" };
      const third = controller.buildActiveClient();
      assert.notEqual(third, second);
      controller.modelInfo.config.networkProbe = async () => ({ ok: true, latencyMs: 1 });
      assert.notEqual(controller.buildActiveClient(), third);
    });
  });

  it("preserves sticky failover when only local budget policy changes", async () => {
    await withController(async({controller,attempts,created})=>{
      const client=controller.buildActiveClient();await client.stream([],[],undefined,()=>{});
      controller.modelInfo={...controller.modelInfo,config:{...controller.modelInfo.config,budgetTokens:50000}};
      assert.equal(controller.buildActiveClient(),client);await client.stream([],[],undefined,()=>{});
      assert.deepEqual(attempts,["gpt-4.1","gpt-4o","gpt-4o"]);assert.equal(created.length,2);
    });
  });
});
