import type { BrokerOutcome } from "./broker.js";
import type { ToolDefinition } from "./model.js";
import type { ForgeRegistry } from "./forge.js";
import type { RecipeEngine } from "./recipes.js";
import { selectJsonPointer } from "./jsonPointer.js";
import type { CoverageService } from "./coverage.js";
import type { TaskStateStore } from "./taskState.js";

export interface LocalTool {
  readonly definition: ToolDefinition;
  readonly backend: string;
  readonly readOnly: (args: Record<string, unknown>) => boolean;
  readonly invoke: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<BrokerOutcome>;
}

const entrySchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable unique record ID" },
    text: { type: "string" },
    status: { type: "string", enum: ["open", "claimed", "blocked"] },
    proofRefs: { type: "array", items: { type: "string" }, description: "Evidence or verified fixture references; references alone are not verification" },
    verification: { type: "object", description: "Optional machine criterion for coverage. evidence-equals requires pointer (JSON Pointer into the retained Evidence) and equals; other kinds validate the exact proof ref. This validates only the declared criterion, not arbitrary prose.", properties: { kind: { type: "string", enum: ["evidence-equals", "forge-fixtures", "recipe-exit", "unknown-resolution"] }, ref: { type: "string" }, pointer: { type: "string" }, equals: { description: "Exact expected JSON value" } }, required: ["kind", "ref"], additionalProperties: false },
  },
  required: ["id", "text"],
  additionalProperties: false,
};

export const taskStateTool = (store: TaskStateStore): LocalTool => ({
  definition: {
    type: "function",
    function: {
      name: "omr_state",
      description: "Read or update durable task goals, constraints, decisions, acceptance claims, active work and artifact references. State survives compaction and rewind. Updates require the current revision; proof references do not by themselves verify a claim.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get", "update"] },
          expected_revision: { type: "integer", minimum: 0 },
          path: { type: "string", description: "Optional JSON Pointer for get (e.g. /goal, /acceptance/0/text or /acceptance/0/proofRefs); large values require child paths or pagination" },
          offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20000 },
          patch: {
            type: "object",
            properties: {
              goal: { type: "string" },
              constraints: { type: "array", items: { type: "string" } },
              decisions: { type: "array", items: entrySchema },
              acceptance: { type: "array", items: entrySchema },
              activeWork: { type: "array", items: entrySchema },
              artifacts: {
                type: "array",
                items: {
                  type: "object",
                  properties: { id: { type: "string" }, path: { type: "string" }, description: { type: "string" }, originSessionId: { type: "string" } },
                  required: ["id", "path"],
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
  backend: "task-state",
  readOnly: args => (args["action"] ?? "get") === "get",
  invoke: async (args, signal) => {
    signal?.throwIfAborted();
    const action = args["action"] ?? "get";
    if (action !== "get" && action !== "update") throw new Error("omr_state action must be get or update");
    if (action === "update" && (!Number.isSafeInteger(args["expected_revision"]) || Number(args["expected_revision"]) < 0)) {
      throw new Error("omr_state update requires a non-negative expected_revision");
    }
    const state = action === "get" ? await store.read() : await store.update(args["patch"], Number(args["expected_revision"]));
    let result: unknown = state;
    if (action === "update" && Buffer.byteLength(JSON.stringify(state)) > 60_000) result = { schema: 1, revision: state.revision, updated: true, statePath: store.path, instruction: "Use get with path/offset/limit to read the full durable state in bounded pages" };
    if (action === "get" && (args["path"] !== undefined || args["offset"] !== undefined || args["limit"] !== undefined || Buffer.byteLength(JSON.stringify(state)) > 60_000)) {
      const path = typeof args["path"] === "string" ? args["path"] : "";
      const selected = selectJsonPointer(state, path); if (!selected.found) throw new Error(`Task state path not found: ${path}`);
      const offset = args["offset"] ?? 0; const limit = args["limit"] ?? (typeof selected.value === "string" ? 4000 : 20);
      if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 20000) throw new Error("Invalid task state pagination");
      let value = selected.value, total: number | null = null, nextOffset: number | null = null;
      if (typeof value === "string" || Array.isArray(value)) { total = value.length; const count = Array.isArray(value) ? Math.min(100, Number(limit)) : Number(limit); value = value.slice(Number(offset), Number(offset) + count); nextOffset = Number(offset) + count < total ? Number(offset) + count : null; }
      const tooLarge = Buffer.byteLength(JSON.stringify(value)) > 60_000;
      result = { schema: 1, revision: state.revision, path, offset, total, nextOffset, ...(tooLarge ? { omitted: true, instruction: "Read child JSON Pointer paths or a smaller page; the full value remains in task-state.json", keys: value && typeof value === "object" ? Object.keys(value) : [] } : { value }) };
    }
    return { tool: "omr_state", text: JSON.stringify(result), structuredContent: result, isError: false, durationMs: 0, evidenceIds: [] };
  },
});

export const forgeManagementTool = (registry: ForgeRegistry): LocalTool => ({
  definition: {
    type: "function",
    function: {
      name: "omr_forge",
      description: "Register immutable JSON stdin/stdout scripts, verify exact semantic fixtures, and explicitly activate/remove versioned function tools. A passing exit code alone is insufficient. No dependencies are installed. Use list to inspect schemas, runs and proof refs. Supported schema keywords: type, properties, required, additionalProperties(boolean), items, enum, const, minLength/maxLength, minimum/maximum, minItems/maxItems, description/title; unsupported keywords fail.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "register", "verify", "activate", "deactivate", "remove"] },
          id: { type: "string" }, version: { type: "string" }, code: { type: "string", description: "Source reads one JSON object from stdin, writes one JSON value to stdout; diagnostics go to stderr" },
          spec: {
            type: "object",
            properties: {
              id: { type: "string" }, version: { type: "string", description: "major.minor.patch; immutable" }, description: { type: "string" },
              interpreter: { type: "string", enum: ["node", "python3", "bash"] },
              dependencies: { type: "array", items: { type: "object", properties: { command: { type: "string" }, versionArgs: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", enum: ["--version", "-version", "-V", "-v", "version"] } }, versionContains: { type: "string" } }, required: ["command"] } },
              inputSchema: { type: "object", description: "Supported JSON schema dialect; root type object required" }, outputSchema: { type: "object" },
              fixtures: { type: "array", minItems: 1, items: { type: "object", properties: { id: { type: "string" }, input: { type: "object" }, expected: { description: "Exact expected JSON value" } }, required: ["id", "input", "expected"] } },
              timeoutSec: { type: "integer", minimum: 1, maximum: 300 }, network: { type: "boolean" },
            },
            required: ["id", "version", "description", "interpreter", "inputSchema", "outputSchema", "fixtures"], additionalProperties: false,
          },
        },
        required: ["action"], additionalProperties: false,
      },
    },
  },
  backend: "forge-management",
  readOnly: args => args["action"] === "list",
  invoke: async (args, signal) => {
    signal?.throwIfAborted();
    const id = typeof args["id"] === "string" ? args["id"] : "";
    const version = typeof args["version"] === "string" ? args["version"] : "";
    let result: unknown; let isError = false;
    switch (args["action"]) {
      case "list": result = await registry.list(id || undefined); break;
      case "register": if (typeof args["code"] !== "string") throw new Error("Forge register requires code"); result = await registry.register(args["spec"], args["code"]); break;
      case "verify": { const proof = await registry.verify(id, version, signal); result = proof; isError = !proof.passed; break; }
      case "activate": await registry.activate(id, version, signal); result = { id, version, active: true }; break;
      case "deactivate": await registry.deactivate(id); result = { id, active: false }; break;
      case "remove": await registry.remove(id, version || undefined); result = { id, version: version || null, removed: true }; break;
      default: throw new Error("Unknown omr_forge action");
    }
    return { tool: "omr_forge", text: JSON.stringify(result), structuredContent: result, isError, durationMs: 0, evidenceIds: [] };
  },
});

export const recipeTool = (engine: RecipeEngine): LocalTool => ({
  definition: { type: "function", function: {
    name: "omr_recipe",
    description: "List, inspect or execute deterministic versioned analysis recipes. javascript retains static JS Evidence; browser-javascript links passive CDP DOM/network, screenshot, captured-script export and static analysis in one persisted episode. Runs record entry/exit conditions and real coverage/Unknowns. Completed means pipeline criteria, not full application understanding. Native Evidence is checked against the active ledger; a missing capability or failed condition is explicit. A replay is a fresh run, not an automatic retry of uncertain effects.",
    parameters: { type: "object", properties: {
      action: { type: "string", enum: ["list", "run", "inspect"] }, recipe: { type: "string", enum: ["javascript", "browser-javascript"] }, run_id: { type: "string" },
      input: { type: "object", properties: { input_path: { type: "string" }, cdp_endpoint: { type: "string", description: "Defaults to the currently owned local browser only" }, target_id: { type: "string" }, observation_ms: { type: "integer", minimum: 0, maximum: 30000 }, min_network_requests: { type: "integer", minimum: 0 }, analysis_timeout_ms: { type: "integer", minimum: 1, maximum: 300000 }, max_heap_mb: { type: "integer", minimum: 128, maximum: 2048 } }, additionalProperties: false },
    }, required: ["action"], additionalProperties: false },
  } },
  backend: "recipe",
  readOnly: args => args["action"] === "list" || args["action"] === "inspect",
  invoke: async (args, signal) => {
    signal?.throwIfAborted(); let result: unknown; let isError = false;
    if (args["action"] === "list") result = { recipes: engine.list(), recentRuns: await engine.recent() };
    else if (args["action"] === "inspect" && typeof args["run_id"] === "string") result = await engine.inspect(args["run_id"]);
    else if (args["action"] === "run" && typeof args["recipe"] === "string") { const run = await engine.run(args["recipe"], args["input"] ?? {}, signal); result = run; isError = run.status !== "completed"; }
    else throw new Error("omr_recipe requires list, inspect with run_id, or run with recipe and input");
    return { tool: "omr_recipe", text: JSON.stringify(result), structuredContent: result, isError, durationMs: 0, evidenceIds: [] };
  },
});

export const coverageTool = (service: CoverageService): LocalTool => ({
  definition: { type: "function", function: { name: "omr_coverage", description: "Assess inspected references, verified declared acceptance predicates, native residual Unknowns and provider coverage gaps. Claims/citations alone do not verify acceptance. Returns recorded target/origin, bounded item/proof pages and measured progress. A recipe's pipeline completion does not certify semantic coverage or arbitrary prose goals. Use item_id or pagination for larger task states.", parameters: { type: "object", properties: { item_id: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false } } },
  backend: "coverage", readOnly: () => true,
  invoke: async (args, signal) => {
    const report = await service.report({ ...(typeof args["item_id"] === "string" ? { itemId: args["item_id"] } : {}), ...(args["offset"] === undefined ? {} : { offset: Number(args["offset"]) }), ...(args["limit"] === undefined ? {} : { limit: Number(args["limit"]) }) }, signal);
    return { tool: "omr_coverage", text: JSON.stringify(report), structuredContent: report, isError: false, durationMs: 0, evidenceIds: [] };
  },
});
