import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { COMMANDS } from "../dist/commands.js";
import { createTheme, stripAnsi, visibleWidth } from "../dist/ansi.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../dist/compaction.js";
import { I18n } from "../dist/i18n/index.js";
import { ModelController } from "../dist/runtime/modelController.js";
import { OutputSink } from "../dist/runtime/output.js";
import { TerminalUi } from "../dist/tui.js";
import { genericOpenAiRoutes, nineRouterRoutes, omniRouteRoutes, startServer } from "./fixtures/fake-routers.mjs";

const servers = [];
const serve = async (routes) => {
  const server = await startServer(routes);
  servers.push(server);
  return server;
};
const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "omr-custom-"));
  dirs.push(dir);
  return dir;
};
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (condition, what) => {
  for (let i = 0; i < 300; i += 1) {
    if (condition()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
};
const theme = createTheme({ COLORTERM: "truecolor", TERM: "xterm-256color" });
const SIZES = [[54, 15], [80, 24], [120, 36]];

/** A real controller and TerminalUi wired together; `onTest` can replace the controller's network test. */
const setup = async ({ language = "en", env = {}, onTest } = {}) => {
  const i18n = new I18n();
  await i18n.initialize(language, { XDG_CONFIG_HOME: tempDir() });
  const output = new OutputSink({ json: true, writeStdout: () => {}, writeStderr: () => {} });
  const controller = new ModelController({ XDG_CONFIG_HOME: tempDir(), OMR_ROUTER_DISCOVERY: "0", ...env }, false, null, output, {
    getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
    setCompactionSettings: () => {},
    onModelUpdated: async () => {},
  });
  const selected = [];
  const ui = new TerminalUi({
    i18n, commands: COMMANDS, theme, providers: () => controller.providers,
    onSubmit: () => {}, onInterrupt: () => {}, onExit: () => {},
    onSelectModel: (...args) => selected.push(args),
    onTestCustomEndpoint: onTest ?? ((request, signal) => controller.testCustomEndpoint(request, signal)),
  });
  output.setUi(ui);
  const open = (focus = null) => ui.openModelPicker(controller.providers, null, "", focus, false, "auto");
  open();
  return { ui, controller, selected, open, i18n };
};
const frame = (ui, cols = 120, rows = 36) => ui.renderFrame(cols, rows).lines.map(stripAnsi).join("\n");
const toCustomTab = (ui) => ui.handleKey("\x1b[Z");
const type = (ui, text) => ui.handlePlain(text);
const enter = (ui) => ui.handleKey("\r");
const wizard = (ui) => ui.picker.wizard;
const currentTab = (ui) => ui.pickerTabs()[ui.picker.selectedTab];
const customIds = (controller) => controller.providers.filter((p) => p.id.startsWith("custom-")).map((p) => p.id);

test("the Custom provider row is pinned above All only in the primary picker", async () => {
  const { ui, controller } = await setup();
  assert.deepEqual(ui.pickerTabs().slice(0, 2).map((tab) => tab.kind), ["custom", "all"]);
  assert.equal(currentTab(ui).kind, "all");
  assert.match(frame(ui), /\+ Custom provider/);
  ui.openCompactionModelPicker(controller.providers, null, "", null, false);
  assert.equal(ui.pickerTabs()[0].kind, "all");
  assert.equal(ui.pickerTabs().some((tab) => tab.kind === "custom"), false);
  ui.openEffortPicker(controller.providers, null, "", "auto");
  assert.equal(ui.pickerTabs().some((tab) => tab.kind === "custom"), false);
  assert.equal(frame(ui).includes("Custom provider"), false);
});

test("wizard happy path with a loopback endpoint and no key", async () => {
  const fake = await serve(genericOpenAiRoutes());
  const { ui, controller, selected } = await setup();
  toCustomTab(ui);
  assert.equal(currentTab(ui).kind, "custom");
  enter(ui);
  assert.equal(wizard(ui).step, "url");
  type(ui, `${fake.origin}/v1`);
  enter(ui);
  assert.equal(wizard(ui).step, "key");
  enter(ui);
  await waitFor(() => wizard(ui) === null, "test result");
  const id = currentTab(ui).id;
  assert.match(id, /^custom-127-0-0-1-\d+$/);
  assert.deepEqual(ui.pickerRows().map((row) => row.modelId), ["cx/example-model", "cx/example-model:thinking", "example-combo"]);
  assert.match(frame(ui), /Connected to http:\/\/127\.0\.0\.1:\d+ · 3 models/);
  assert.deepEqual(customIds(controller), [id]);
  enter(ui);
  enter(ui);
  assert.deepEqual(selected, [[id, "cx/example-model", "auto", false]]);
});

test("origin-only input tries /v1 first", async () => {
  const fake = await serve(genericOpenAiRoutes());
  const { ui, controller } = await setup();
  toCustomTab(ui);
  enter(ui);
  type(ui, `127.0.0.1:${fake.port}`);
  enter(ui);
  enter(ui);
  await waitFor(() => wizard(ui) === null, "test result");
  const provider = controller.providers.find((p) => p.id === currentTab(ui).id);
  assert.equal(provider.baseUrl, `${fake.origin}/v1`);
  assert.equal(fake.requests[0].path, "/v1/models");
});

test("remote origin with a key requires confirmation and the key is masked", async () => {
  for (const [scheme, expected] of [["https", /Send the API key to https:\/\/api\.example\.test\?/], ["http", /plain HTTP/]]) {
    const calls = [];
    const { ui } = await setup({ onTest: async (request) => { calls.push(request); return { status: "unreachable", origin: `${scheme}://api.example.test` }; } });
    toCustomTab(ui);
    enter(ui);
    type(ui, `${scheme}://api.example.test/v1`);
    enter(ui);
    type(ui, "sk-secret-123456");
    const everyFrame = [];
    const snap = () => { for (const [cols, rows] of SIZES) everyFrame.push(frame(ui, cols, rows)); };
    snap();
    assert.match(frame(ui), /Key › ••••••••/);
    enter(ui);
    assert.equal(wizard(ui).step, "confirm");
    snap();
    assert.match(frame(ui), expected);
    assert.equal(calls.length, 0);
    ui.handleKey("\x1b");
    assert.equal(wizard(ui).step, "key");
    enter(ui);
    assert.equal(wizard(ui).step, "confirm");
    enter(ui);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].key, { kind: "literal", value: "sk-secret-123456" });
    await waitFor(() => wizard(ui)?.step === "url", "failure");
    snap();
    assert.equal(wizard(ui).key, "");
    for (const text of everyFrame) assert.equal(text.includes("sk-secret"), false);
  }
});

test("401 returns to the key step with a cleared field; 404 returns to the URL step", async () => {
  const locked = await serve(omniRouteRoutes({ requireKey: "right-key" }));
  const missing = await serve({});
  const { ui } = await setup();
  toCustomTab(ui);
  enter(ui);
  type(ui, `${locked.origin}/v1`);
  enter(ui);
  enter(ui);
  await waitFor(() => wizard(ui)?.step === "key" && wizard(ui).error, "401");
  assert.match(frame(ui), /API key required/);
  assert.equal(wizard(ui).key, "");
  ui.handleKey("\x1b");
  ui.handleKey("\x15");
  type(ui, `${missing.origin}/v1`);
  enter(ui);
  enter(ui);
  await waitFor(() => wizard(ui)?.step === "url" && wizard(ui).error, "404");
  assert.match(frame(ui), /No model list here \(HTTP 404\)/);
  assert.equal(wizard(ui).key, "");
});

test("env-reference keys are resolved by name and never inherit other credentials", async () => {
  const fake = await serve(omniRouteRoutes({ requireKey: "kx" }));
  const open = await serve(genericOpenAiRoutes());
  const env = { MY_ROUTER_KEY: "kx", OPENAI_API_KEY: "sk-leak", OMR_API_KEY: "sk-leak-2" };
  const run = async (keyText, target) => {
    const made = await setup({ env });
    toCustomTab(made.ui);
    enter(made.ui);
    type(made.ui, `${target.origin}/v1`);
    enter(made.ui);
    type(made.ui, keyText);
    enter(made.ui);
    return made;
  };
  const withEnv = await run("$MY_ROUTER_KEY", fake);
  await waitFor(() => wizard(withEnv.ui) === null, "env key result");
  assert.equal(fake.requests.at(-1).headers.authorization, "Bearer kx");
  const before = fake.requests.length;
  const missing = await run("$MISSING_KEY", fake);
  assert.equal(wizard(missing.ui).step, "key");
  await waitFor(() => wizard(missing.ui)?.error, "missing env");
  assert.match(frame(missing.ui), /Environment variable MISSING_KEY is not set\./);
  assert.equal(fake.requests.length, before);
  const bare = await run("", open);
  await waitFor(() => wizard(bare.ui) === null, "no key result");
  assert.equal(open.requests.some((request) => request.headers.authorization !== undefined), false);
  for (const request of [...fake.requests, ...open.requests]) assert.equal(JSON.stringify(request.headers).includes("sk-leak"), false);
});

test("cancel and stale results are ignored", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const slow = await serve({
    "GET /v1/models": async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { body: { object: "list", data: [{ id: "late-model" }] } };
    },
  });
  const { ui, controller } = await setup();
  toCustomTab(ui);
  enter(ui);
  type(ui, `${slow.origin}/v1`);
  enter(ui);
  enter(ui);
  assert.equal(wizard(ui).step, "testing");
  await waitFor(() => calls === 1, "first request");
  ui.handleKey("\x1b");
  assert.equal(wizard(ui).step, "key");
  release();
  await sleep(150);
  assert.deepEqual(customIds(controller), []);
  assert.equal(currentTab(ui).kind, "custom");
  enter(ui);
  await waitFor(() => wizard(ui) === null, "second attempt");
  assert.deepEqual(ui.pickerRows().map((row) => row.modelId), ["late-model"]);
});

test("wizard URL validation errors are localized", async () => {
  for (const [language, scheme, credentials] of [
    ["en", "Only http:// and https://", "Remove the user name or password"],
    ["tr", "Yalnızca http:// ve https://", "Adresteki kullanıcı adını"],
  ]) {
    const { ui } = await setup({ language });
    toCustomTab(ui);
    enter(ui);
    type(ui, "ftp://x");
    enter(ui);
    assert.match(frame(ui), new RegExp(scheme));
    ui.handleKey("\x15");
    type(ui, "http://u:p@h");
    enter(ui);
    assert.match(frame(ui), new RegExp(credentials));
    assert.equal(wizard(ui).step, "url");
  }
});

test("an auth-required router opens the wizard at the key step for the same provider", async () => {
  const secret = "ko-test-secret";
  const omni = await serve(omniRouteRoutes({ requireKey: secret }));
  const { ui, controller, open } = await setup({ env: { OMR_ROUTER_DISCOVERY: "1", OMR_ROUTER_PORTS: String(omni.port) } });
  await controller.startRouterDiscovery(false);
  assert.equal(controller.providers.find((p) => p.id === "omniroute").catalogStatus, "auth-required");
  open("omniroute");
  assert.equal(currentTab(ui).id, "omniroute");
  const frames = [frame(ui)];
  enter(ui);
  assert.equal(wizard(ui).step, "key");
  assert.equal(wizard(ui).url, `${omni.origin}/v1`);
  type(ui, secret);
  frames.push(frame(ui));
  enter(ui);
  await waitFor(() => wizard(ui) === null, "key accepted");
  frames.push(frame(ui));
  const router = controller.providers.find((p) => p.id === "omniroute");
  assert.equal(router.catalogStatus, "ok");
  assert.equal(router.models.length, 3);
  assert.deepEqual(customIds(controller), []);
  assert.equal(currentTab(ui).id, "omniroute");
  for (const text of frames) assert.equal(text.includes(secret), false);
  // A later scan keeps working with the key typed in this session.
  await controller.startRouterDiscovery(true);
  assert.equal(controller.providers.find((p) => p.id === "omniroute").catalogStatus, "ok");
});

test("wizard frames fit 54/80/120 columns in both languages", async () => {
  for (const language of ["en", "tr"]) {
    const hang = await setup({ language, onTest: () => new Promise(() => {}) });
    const check = (made, label) => {
      for (const [cols, rows] of SIZES) {
        for (const line of made.ui.renderFrame(cols, rows).lines) assert.ok(visibleWidth(line) <= cols, `${language} ${label} ${cols}: ${stripAnsi(line)}`);
      }
    };
    check(hang, "tab");
    toCustomTab(hang.ui);
    check(hang, "custom tab");
    enter(hang.ui);
    check(hang, "url");
    type(hang.ui, "http://203.0.113.9:8000/v1");
    enter(hang.ui);
    check(hang, "key");
    type(hang.ui, "sk-width-secret");
    enter(hang.ui);
    check(hang, "confirm");
    enter(hang.ui);
    assert.equal(wizard(hang.ui).step, "testing");
    check(hang, "testing");
    type(hang.ui, "ignored");
    ui_assert_no_secret(hang.ui);
    hang.ui.handleKey("\x03");
    assert.equal(hang.ui.isModelPickerOpen, false);
  }
});
function ui_assert_no_secret(ui) {
  for (const [cols, rows] of SIZES) assert.equal(frame(ui, cols, rows).includes("sk-width-secret"), false);
}
