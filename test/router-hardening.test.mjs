import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { parseArgs } from "../dist/args.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../dist/compaction.js";
import { modelConfigPath } from "../dist/modelConfig.js";
import { ModelController } from "../dist/runtime/modelController.js";
import { OutputSink } from "../dist/runtime/output.js";
import { runOmr } from "../dist/runtime.js";
import { FakeModel, FakeRea } from "../dist/testing/fakes.js";
import { genericOpenAiRoutes, nineRouterRoutes, startServer } from "./fixtures/fake-routers.mjs";
import { useModelCatalogFixtures } from "./fixtures/model-catalogs.mjs";

useModelCatalogFixtures();

const servers = [];
const serve = async (routes) => { const server = await startServer(routes); servers.push(server); return server; };
const dirs = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "omr-harden-")); dirs.push(dir); return dir; };
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const controllerFor = (env) => new ModelController(env, false, null, new OutputSink({ json: true, writeStdout: () => {}, writeStderr: () => {} }), {
  getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS, setCompactionSettings: () => {}, onModelUpdated: async () => {},
});
const authorizations = (server) => server.requests.map((request) => request.headers.authorization).filter(Boolean);

test("/model endpoint does not reuse the active key for another origin", async () => {
  const active = await serve(genericOpenAiRoutes());
  const other = await serve(genericOpenAiRoutes());
  const env = { XDG_CONFIG_HOME: tempDir(), OMR_ROUTER_DISCOVERY: "0", OPENAI_API_KEY: "sk-a", OPENAI_BASE_URL: `${active.origin}/v1`, OMR_MODEL: "gpt-4.1" };
  const controller = controllerFor(env);
  assert.equal(controller.modelInfo.config.apiKey, "sk-a");
  await controller.configureCustomEndpoint(`${other.origin}/v1`);
  assert.deepEqual(authorizations(other), []);
  assert.equal(JSON.stringify(other.requests.map((request) => request.headers)).includes("sk-a"), false);
  // The same origin still inherits the active provider's key.
  const same = controllerFor({ ...env, XDG_CONFIG_HOME: tempDir() });
  await same.configureCustomEndpoint(`${active.origin}/v1`);
  assert.ok(authorizations(active).includes("Bearer sk-a"));
});

test("a saved router on a custom port is refreshed by the bounded fetch with its own key", async () => {
  const nine = await serve(nineRouterRoutes({ requireKey: "saved-key" }));
  const env = { XDG_CONFIG_HOME: tempDir(), OMR_ROUTER_DISCOVERY: "0", MY_ROUTER_KEY: "saved-key", OPENAI_API_KEY: "sk-other" };
  const path = modelConfigPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ provider: "9router", model: "cx/example-model", providers: {
    "9router": { name: "9Router", base_url: `${nine.origin}/v1`, protocol: "openai-chat", router: "9router", api_key_env: "MY_ROUTER_KEY" },
  } }));
  const controller = controllerFor(env);
  await controller.startRouterDiscovery(false);
  const router = controller.providers.find((provider) => provider.id === "9router");
  assert.equal(router.provenance, "config-named");
  assert.equal(router.catalogStatus, "ok");
  assert.equal(router.models.length, 3);
  assert.deepEqual(authorizations(nine), ["Bearer saved-key"]);
  // Saved routers never go through the legacy probe, which would also send x-api-key.
  assert.equal(nine.requests.some((request) => request.headers["x-api-key"] !== undefined), false);
});

test("/providers JSON includes router and catalog_status", async () => {
  const nine = await serve(nineRouterRoutes());
  const tmp = tempDir();
  const out = [];
  const code = await runOmr(parseArgs(["node", "omr", "--json", "/providers"]), {
    cwd: tmp,
    env: { XDG_CONFIG_HOME: tmp, OMR_ROUTER_DISCOVERY: "0", OMR_9ROUTER_BASE_URL: `${nine.origin}/v1`, OPENAI_API_KEY: "sk-test-fake-key", OMR_MODEL: "gpt-4.1" },
    sessionsRootDir: join(tmp, "sessions"),
    connectRea: async (sessionDir) => new FakeRea(sessionDir),
    createModelClient: () => new FakeModel([{ content: "ok" }]),
    writeStdout: (text) => out.push(text),
    writeStderr: () => {},
  });
  assert.equal(code, 0);
  const events = out.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const result = events.find((event) => event.type === "command.result" && event.command === "providers");
  assert.ok(result);
  const router = result.payload.providers.find((provider) => provider.id === "9router");
  assert.equal(router.router, "9router");
  assert.equal(router.catalog_status, "ok");
  assert.equal(router.model_count, 3);
  assert.equal(result.payload.providers.find((provider) => provider.id === "openai").router, null);
  assert.equal(JSON.stringify(result).includes("sk-test-fake-key"), false);
});
