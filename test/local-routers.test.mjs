import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { COMMANDS } from "../dist/commands.js";
import { createTheme, stripAnsi, visibleWidth } from "../dist/ansi.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../dist/compaction.js";
import { I18n } from "../dist/i18n/index.js";
import { modelConfigPath, resolveModelConfig } from "../dist/modelConfig.js";
import { ModelController } from "../dist/runtime/modelController.js";
import { OutputSink } from "../dist/runtime/output.js";
import { TerminalUi } from "../dist/tui.js";
import { boundedGet } from "../dist/boundedHttp.js";
import { customProviderId, parseKeyInput, sameEndpoint, validateCustomBaseUrl } from "../dist/customEndpoint.js";
import { DISCOVERY_LIMITS, discoverLocalRouters, fetchCatalog, identifyRouter, routerCandidates } from "../dist/localRouters.js";
import { lookupModelsDev, slimModelsDev } from "../dist/modelLimits.js";
import { BUILTIN_PROVIDERS, ROUTER_PRODUCTS, discoverProvidersSync, extractLiveModelsFromPayload, refreshAllProviders } from "../dist/providers.js";
import { genericOpenAiRoutes, ipv6Available, nineRouterRoutes, omniRouteRoutes, startServer } from "./fixtures/fake-routers.mjs";

const servers = [];
const serve = async (routes, host) => {
  const server = await startServer(routes, host);
  servers.push(server);
  return server;
};
after(async () => { await Promise.all(servers.map((server) => server.close())); });
const live = () => new AbortController().signal;
const candidate = (server) => ({ origin: server.origin, apiBase: `${server.origin}/v1` });

test("validateCustomBaseUrl canonicalizes accepted base URLs", () => {
  const table = [
    ["http://127.0.0.1:8000/v1/", { baseUrl: "http://127.0.0.1:8000/v1", loopback: true, originOnly: false }],
    ["127.0.0.1:8000", { baseUrl: "http://127.0.0.1:8000", loopback: true, originOnly: true }],
    ["api.example.com/v1", { baseUrl: "https://api.example.com/v1", loopback: false, secure: true }],
    ["https://h.example/openai/v1/models", { baseUrl: "https://h.example/openai/v1" }],
    ["http://[::1]:20128/v1", { baseUrl: "http://[::1]:20128/v1", loopback: true, origin: "http://[::1]:20128" }],
    ["HTTPS://API.Example.com/V1", { baseUrl: "https://api.example.com/V1" }],
    ["localhost:20128", { baseUrl: "http://localhost:20128", loopback: true }],
  ];
  for (const [raw, expected] of table) {
    const result = validateCustomBaseUrl(raw);
    assert.equal(result.ok, true, raw);
    for (const [key, value] of Object.entries(expected)) assert.equal(result.value[key], value, `${raw} ${key}`);
  }
});

test("validateCustomBaseUrl rejects unsafe input with a reason", () => {
  const table = [
    ["", "empty"], ["ftp://x", "scheme"], ["file:///etc/passwd", "scheme"], ["javascript:alert(1)", "scheme"],
    ["http://u:p@h/v1", "credentials"], ["http://h/v1?k=1", "query"], ["http://h/v1?", "query"], ["http://h/v1#x", "query"],
    ["http://0.0.0.0:1/v1", "host"], ["http://[::]/v1", "host"], ["http://224.0.0.1/v1", "host"], ["http://255.255.255.255/", "host"],
    ["http://h/\u0007", "invalid"], ["http://h/‮", "invalid"], ["http://h /v1", "invalid"],
    [`https://h/${"a".repeat(2045)}`, "too-long"],
  ];
  for (const [raw, reason] of table) {
    const result = validateCustomBaseUrl(raw);
    assert.equal(result.ok, false, raw.slice(0, 40));
    assert.equal(result.reason, reason, raw.slice(0, 40));
  }
  assert.equal(validateCustomBaseUrl("http://0.0.0.0:1/v1").host, "0.0.0.0");
});

test("parseKeyInput distinguishes none, literal and env references", () => {
  assert.deepEqual(parseKeyInput("").value, { kind: "none" });
  assert.deepEqual(parseKeyInput("  ").value, { kind: "none" });
  for (const [raw, name] of [["$OPENAI_KEY", "OPENAI_KEY"], ["${A_B}", "A_B"], ["env:FOO", "FOO"]]) {
    assert.deepEqual(parseKeyInput(raw).value, { kind: "env", name }, raw);
  }
  assert.deepEqual(parseKeyInput("sk-abc").value, { kind: "literal", value: "sk-abc" });
  for (const raw of ["a b", "\x01", "a".repeat(4097)]) assert.equal(parseKeyInput(raw).ok, false, raw.slice(0, 8));
});

test("customProviderId is stable, colon-free and unique", () => {
  const id = (raw, taken = new Set()) => customProviderId(validateCustomBaseUrl(raw).value, taken);
  assert.equal(id("http://127.0.0.1:8000/v1"), "custom-127-0-0-1-8000");
  assert.equal(id("https://api.example.com/v1"), "custom-api-example-com");
  assert.equal(id("https://api.example.com/v1", new Set(["custom-api-example-com"])), "custom-api-example-com-2");
  for (const raw of ["http://[::1]:20128/v1", "https://a.b.c/x", "localhost:1", `https://${"a".repeat(60)}.example.com`]) {
    const value = id(raw);
    assert.ok(!value.includes(":") && value !== "custom" && value.length <= 64, value);
    assert.ok(!BUILTIN_PROVIDERS.some((spec) => spec.id === value));
  }
});

test("sameEndpoint treats loopback spellings as one endpoint", () => {
  assert.equal(sameEndpoint("http://localhost:20128/v1", "http://127.0.0.1:20128/v1/"), true);
  assert.equal(sameEndpoint("http://[::1]:20128/v1", "http://127.0.0.1:20128/v1"), true);
  assert.equal(sameEndpoint("http://127.0.0.1:20128/v1", "http://127.0.0.1:20127/v1"), false);
  assert.equal(sameEndpoint("https://API.example.com/v1", "https://api.example.com/v1"), true);
  assert.equal(sameEndpoint("https://api.example.com/v1", "https://api.example.com/V1"), false);
});

test("boundedGet refuses redirects, caps bodies, times out and aborts", async () => {
  const trap = await serve({ "GET /x": { body: { trapped: true } } });
  const server = await serve({
    "GET /r": { status: 302, headers: { location: `${trap.origin}/x` } },
    "GET /big": { body: Buffer.alloc(5 * 1024 * 1024, 120) },
    "GET /hang": "hang",
    "GET /ok": { body: { fine: true } },
  });
  const redirected = await boundedGet(`${server.origin}/r`, { timeoutMs: 1000, maxBytes: 1024 });
  assert.equal(redirected.kind, "response");
  assert.equal(redirected.status, 302);
  assert.equal(trap.requests.length, 0);
  assert.equal((await boundedGet(`${server.origin}/big`, { timeoutMs: 5000, maxBytes: 4 * 1024 * 1024 })).kind, "too-large");
  const started = performance.now();
  assert.equal((await boundedGet(`${server.origin}/hang`, { timeoutMs: 200, maxBytes: 1024 })).kind, "timeout");
  assert.ok(performance.now() - started < 600);
  const closed = await startServer({});
  await closed.close();
  assert.equal((await boundedGet(`${closed.origin}/x`, { timeoutMs: 5000, maxBytes: 1024 })).kind, "unreachable");
  assert.equal((await boundedGet(`${server.origin}/ok`, { timeoutMs: 1000, maxBytes: 1024, signal: AbortSignal.abort() })).kind, "aborted");
  const ok = await boundedGet(`${server.origin}/ok`, { timeoutMs: 1000, maxBytes: 1024 });
  assert.deepEqual(JSON.parse(ok.body), { fine: true });
  for (const request of server.requests) {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
  }
});

test("identifyRouter recognizes 9Router and OmniRoute by their identity endpoints", async () => {
  const nine = await serve(nineRouterRoutes());
  const omni = await serve(omniRouteRoutes());
  assert.equal(await identifyRouter(nine.origin, live()), "9router");
  assert.equal(await identifyRouter(omni.origin, live()), "omniroute");
  const closed = await startServer({});
  await closed.close();
  assert.equal(await identifyRouter(closed.origin, live()), "unreachable");
});

test("a generic OpenAI-compatible server is never labeled", async () => {
  const generic = await serve(genericOpenAiRoutes());
  const healthOnly = await serve({ ...genericOpenAiRoutes(), "GET /api/health": { body: { status: "ok", timestamp: "2026-01-01T00:00:00Z" } } });
  assert.equal(await identifyRouter(generic.origin, live()), "unknown");
  assert.equal(await identifyRouter(healthOnly.origin, live()), "unknown");
  assert.deepEqual(await discoverLocalRouters({ env: {}, signal: live(), candidates: [candidate(generic), candidate(healthOnly)] }), []);
});

test("a server answering both fingerprints is ambiguous and unlabeled", async () => {
  const both = await serve({
    ...nineRouterRoutes(),
    ...omniRouteRoutes(),
    "GET /api/health": { body: { ok: true, status: "ok", timestamp: "2026-01-01T00:00:00Z" } },
  });
  assert.equal(await identifyRouter(both.origin, live()), "ambiguous");
  assert.deepEqual(await discoverLocalRouters({ env: {}, signal: live(), candidates: [candidate(both)] }), []);
});

test("the OmniRoute card must match exactly and advertised URLs are never followed", async () => {
  const trap = await serve({});
  const fork = await serve({
    ...omniRouteRoutes(),
    "GET /.well-known/agent.json": { body: { name: "OmniRoute AI Gateway (fork)", capabilities: {}, skills: [] } },
  });
  assert.equal(await identifyRouter(fork.origin, live()), "unknown");
  const real = await serve(omniRouteRoutes({ cardUrl: `${trap.origin}/v1` }));
  assert.equal(await identifyRouter(real.origin, live()), "omniroute");
  await discoverLocalRouters({ env: {}, signal: live(), candidates: [candidate(real)] });
  assert.equal(trap.requests.length, 0);
});

test("fetchCatalog maps HTTP outcomes to statuses", async () => {
  const rows = [{ id: "m1" }];
  const reply = (spec) => spec;
  const server = await serve({
    "GET /ok/models": reply({ body: { object: "list", data: rows } }),
    "GET /empty/models": reply({ body: { object: "list", data: [] } }),
    "GET /401/models": reply({ status: 401, body: {} }),
    "GET /403/models": reply({ status: 403, body: {} }),
    "GET /404/models": reply({ status: 404, body: {} }),
    "GET /html/models": reply({ headers: { "content-type": "text/html" }, body: "<!doctype html><title>x</title>" }),
    "GET /bad/models": reply({ body: "{not json" }),
    "GET /shape/models": reply({ body: { data: "x" } }),
    "GET /429/models": reply({ status: 429, body: {} }),
    "GET /503/models": reply({ status: 503, body: {} }),
    "GET /301/models": reply({ status: 301, headers: { location: "http://127.0.0.1:9/x" }, body: "" }),
    "GET /big/models": reply({ body: Buffer.alloc(DISCOVERY_LIMITS.catalogMaxBytes + 1024, 120) }),
  });
  const table = [
    ["ok", "ok"], ["empty", "empty"], ["401", "auth-required", 401], ["403", "denied"], ["404", "api-not-found"],
    ["html", "api-not-found"], ["bad", "malformed"], ["shape", "malformed"], ["429", "http-error"], ["503", "http-error"],
    ["301", "redirect"], ["big", "too-large"],
  ];
  for (const [path, status, httpStatus] of table) {
    const result = await fetchCatalog(`${server.origin}/${path}`, "", { signal: live(), timeoutMs: 5000 });
    assert.equal(result.status, status, path);
    if (httpStatus) assert.equal(result.httpStatus, httpStatus);
  }
  const ok = await fetchCatalog(`${server.origin}/ok`, "", { signal: live(), timeoutMs: 5000 });
  assert.deepEqual(ok.models.map((m) => m.id), ["m1"]);
});

test("fetchCatalog pages with encoded cursors and stops safely", async () => {
  const page = (n, more, last) => ({ body: { object: "list", data: [{ id: n === 1 ? "a/1:x" : `m${n}` }], has_more: more, ...(more ? { last_id: last } : {}) } });
  const paged = await serve({
    "GET /three/models": (req, url) => {
      const after = url.searchParams.get("after");
      if (after === null) return page(1, true, "a/1:x");
      if (after === "a/1:x") return page(2, true, "m2");
      return page(3, false);
    },
    "GET /same/models": () => page(1, true, "same"),
    "GET /many/models": (req, url) => {
      const n = Number((url.searchParams.get("after") ?? "c0").slice(1)) + 1;
      return { body: { object: "list", data: [{ id: `row-${n}` }], has_more: true, last_id: `c${n}` } };
    },
    "GET /rows/models": { body: { object: "list", data: Array.from({ length: 10_001 }, (_, i) => ({ id: `r${i}` })) } },
  });
  const options = { signal: live(), timeoutMs: 5000 };
  const three = await fetchCatalog(`${paged.origin}/three`, "", options);
  assert.deepEqual(three.models.map((m) => m.id), ["a/1:x", "m2", "m3"]);
  assert.equal(three.partial, false);
  const second = paged.requests.filter((r) => r.path === "/three/models")[1];
  assert.ok(second.search.includes("after=a%2F1%3Ax"), second.search);
  const same = await fetchCatalog(`${paged.origin}/same`, "", options);
  assert.equal(same.partial, true);
  assert.equal(paged.requests.filter((r) => r.path === "/same/models").length, 2);
  const many = await fetchCatalog(`${paged.origin}/many`, "", options);
  assert.equal(many.partial, true);
  assert.equal(paged.requests.filter((r) => r.path === "/many/models").length, DISCOVERY_LIMITS.catalogMaxPages);
  const rows = await fetchCatalog(`${paged.origin}/rows`, "", options);
  assert.equal(rows.models.length, 10_000);
  assert.equal(rows.partial, true);
  assert.equal(rows.status, "partial");
});

test("catalog rows keep exact IDs and drop unsafe or non-chat rows", async () => {
  const server = await serve({
    "GET /v1/models": {
      body: {
        object: "list",
        data: [
          { id: "cx/gpt-x:thinking" }, { id: "auto/coding:fast" }, { id: "A/B" }, { id: "A/B" },
          { id: "\u001b[31mx" }, { id: "x".repeat(300) }, { id: "e", kind: "embedding" }, { id: "text-embedding-3" },
          { id: "tts-combo", kind: "chat" }, { id: " padded " }, { id: "bidi‮id" },
        ],
      },
    },
  });
  const result = await fetchCatalog(`${server.origin}/v1`, "", { signal: live(), timeoutMs: 5000 });
  assert.deepEqual(result.models.map((m) => m.id), ["cx/gpt-x:thinking", "auto/coding:fast", "A/B", "tts-combo"]);
});

test("router limits follow the provenance rule", () => {
  const caps = (row) => {
    const [entry] = extractLiveModelsFromPayload("router", { data: [{ id: "m", ...row }] }, { kindAware: true });
    return typeof entry === "string" ? {} : (entry.capabilities ?? {});
  };
  assert.deepEqual(caps({ context_length: 64000, max_completion_tokens: 8000 }), { contextWindow: 64000, maxOutputTokens: 8000 });
  assert.deepEqual(caps({ context_length: 8000, max_output_tokens: 8000 }), {});
  assert.deepEqual(caps({ context_length: 512 }), {});
  assert.deepEqual(caps({ context_length: "64000" }), { contextWindow: 64000 });
  assert.deepEqual(caps({ context_length: -1 }), {});
  assert.deepEqual(caps({ context_length: 200_000_000 }), {});
  const index = slimModelsDev({ openai: { models: { "gpt-4.1": { limit: { context: 1047576, output: 32768 } } } } });
  assert.notEqual(lookupModelsDev(index, "openai", "gpt-4.1"), null);
  assert.equal(lookupModelsDev(index, "9router", "gpt-4.1"), null);
  assert.equal(lookupModelsDev(index, "omniroute", "gpt-4.1"), null);
});

test("discovery never sends credentials and binds router keys to their origin", async () => {
  const nine = await serve(nineRouterRoutes());
  const omni = await serve(omniRouteRoutes());
  const generic = await serve(genericOpenAiRoutes());
  const candidates = [nine, omni, generic].map(candidate);
  const base = { OPENAI_API_KEY: "sk-o", ANTHROPIC_API_KEY: "sk-a", OPENROUTER_API_KEY: "sk-r", OMR_API_KEY: "sk-m" };
  await discoverLocalRouters({ env: base, signal: live(), candidates });
  for (const request of [nine, omni, generic].flatMap((s) => s.requests)) {
    for (const header of ["authorization", "x-api-key", "cookie", "proxy-authorization"]) assert.equal(request.headers[header], undefined, `${request.path} ${header}`);
  }
  for (const server of [nine, omni, generic]) server.requests.length = 0;
  await discoverLocalRouters({ env: { ...base, OMR_9ROUTER_API_KEY: "k9" }, signal: live(), candidates });
  const withAuth = [nine, omni, generic].flatMap((s) => s.requests).filter((r) => r.headers.authorization !== undefined);
  assert.deepEqual(withAuth.map((r) => [r.path, r.headers.authorization]), [["/v1/models", "Bearer k9"]]);
  assert.equal(nine.requests.some((r) => r.path === "/v1/models" && r.headers.authorization === "Bearer k9"), true);
  for (const request of [nine, omni, generic].flatMap((s) => s.requests)) assert.equal(request.headers["x-api-key"], undefined);
});

test("discovery respects its budget and cancellation", async () => {
  const hanging = await serve({ "GET /api/health": "hang" });
  const nine = await serve(nineRouterRoutes());
  const started = performance.now();
  const found = await discoverLocalRouters({ env: {}, signal: live(), candidates: [candidate(hanging), candidate(nine)] });
  assert.ok(performance.now() - started < DISCOVERY_LIMITS.scanBudgetMs + 400, `${performance.now() - started}`);
  assert.deepEqual(found.map((r) => r.product), ["9router"]);

  const controller = new AbortController();
  const seen = [];
  const slow = await serve({ "GET /api/health": "hang" });
  const run = discoverLocalRouters({ env: {}, signal: controller.signal, candidates: [candidate(slow)], onRouter: (r) => seen.push(r) });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const aborted = performance.now();
  controller.abort();
  await run;
  assert.ok(performance.now() - aborted < 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(seen, []);
});

test("routerCandidates honors overrides", () => {
  const defaults = routerCandidates({});
  assert.deepEqual(defaults.map((c) => c.origin), [
    "http://127.0.0.1:20128", "http://[::1]:20128", "http://127.0.0.1:20127", "http://[::1]:20127", "http://127.0.0.1:20129", "http://[::1]:20129",
  ]);
  assert.equal(defaults[0].apiBase, "http://127.0.0.1:20128/v1");
  assert.deepEqual(routerCandidates({ OMR_ROUTER_PORTS: "1234, 99999, abc,1234" }).map((c) => c.origin), ["http://127.0.0.1:1234", "http://[::1]:1234"]);
  assert.deepEqual(routerCandidates({ OMR_ROUTER_PORTS: "abc" }).length, 6);
  assert.deepEqual(routerCandidates({ OMR_ROUTER_DISCOVERY: "0" }), []);
  const explicit = routerCandidates({ OMR_9ROUTER_BASE_URL: "http://127.0.0.1:9/v1" });
  assert.equal(explicit[0].explicit, "9router");
  assert.equal(explicit[0].apiBase, "http://127.0.0.1:9/v1");
  assert.equal(routerCandidates({ OMR_9ROUTER_BASE_URL: "http://127.0.0.1:20128/v1" }).filter((c) => c.origin === "http://127.0.0.1:20128").length, 1);
  assert.deepEqual(routerCandidates({ OMR_OMNIROUTE_BASE_URL: "not a url", OMR_ROUTER_DISCOVERY: "0" }), []);
  const proxied = routerCandidates({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy.invalid:3128", OMR_OMNIROUTE_BASE_URL: "http://127.0.0.1:9/v1" });
  assert.deepEqual(proxied.map((c) => c.explicit), ["omniroute"]);
});

test("IPv6 loopback candidates are probed", { skip: !(await ipv6Available()) }, async () => {
  const nine = await serve(nineRouterRoutes(), "::1");
  assert.match(nine.origin, /^http:\/\/\[::1\]:\d+$/);
  const found = await discoverLocalRouters({ env: {}, signal: live(), candidates: [candidate(nine)] });
  assert.equal(found.length, 1);
  assert.equal(found[0].origin, nine.origin);
  assert.equal(found[0].product, "9router");
});

// ── Controller and picker (P2) ───────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempDirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "omr-routers-"));
  tempDirs.push(dir);
  return dir;
};
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

/** A controller whose UI is a recording stub. `env` is complete: nothing is inherited from the host. */
const makeController = (env) => {
  const calls = [];
  const output = new OutputSink({ json: true, writeStdout: () => {}, writeStderr: () => {} });
  output.setUi({
    openModelPicker: (...args) => calls.push({ type: "open", providers: args[0], args }),
    updateModelPicker: (patch) => calls.push({ type: "update", patch }),
    setStatus: () => {}, addSystem: () => {}, showOutput: () => {}, setNetworkStatus: () => {},
  });
  const controller = new ModelController(env, false, null, output, {
    getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
    setCompactionSettings: () => {},
    onModelUpdated: async () => {},
  });
  return { controller, calls };
};
const hasHeader = (server, name) => server.requests.some((request) => request.headers[name] !== undefined);

test("opening the picker paints before discovery and adds routers incrementally", async () => {
  const nine = await serve(nineRouterRoutes());
  const generic = await serve(genericOpenAiRoutes());
  const { controller, calls } = makeController({
    XDG_CONFIG_HOME: tempDir(), OMR_ROUTER_DISCOVERY: "1", OMR_ROUTER_PORTS: String(nine.port),
    OPENAI_API_KEY: "sk-test-openai", OPENAI_BASE_URL: `${generic.origin}/v1`,
  });
  const started = performance.now();
  controller.openInteractiveModelPicker(null);
  assert.ok(performance.now() - started < 50);
  const opened = calls.find((call) => call.type === "open");
  assert.ok(opened);
  assert.equal(opened.providers.some((provider) => provider.id === "9router"), false);
  await controller.whenRouterDiscoveryIdle();
  const router = controller.providers.find((provider) => provider.id === "9router");
  assert.equal(router.product, "9router");
  assert.equal(router.catalogStatus, "ok");
  assert.equal(router.provenance, "detected");
  assert.deepEqual(router.models.map((model) => model.id), ["cx/example-model", "cx/example-model:thinking", "example-combo"]);
  assert.equal(calls.filter((call) => call.type === "update").at(-1).patch.scanning, false);
  assert.ok(calls.some((call) => call.type === "update" && call.patch.scanning === true));
  assert.equal(hasHeader(nine, "authorization"), false);
  assert.equal(nine.requests.some((request) => JSON.stringify(request.headers).includes("sk-test-openai")), false);
  await sleep(50);
});

test("a second open within the TTL does not re-probe, a forced refresh does", async () => {
  const nine = await serve(nineRouterRoutes());
  const { controller } = makeController({ XDG_CONFIG_HOME: tempDir(), OMR_ROUTER_DISCOVERY: "1", OMR_ROUTER_PORTS: String(nine.port) });
  await controller.startRouterDiscovery(false);
  const first = nine.requests.length;
  assert.ok(first > 0);
  controller.openInteractiveModelPicker(null);
  await controller.whenRouterDiscoveryIdle();
  assert.equal(nine.requests.length, first);
  await controller.triggerProvidersRefresh(true);
  assert.ok(nine.requests.length > first);
  await sleep(50);
});

test("refresh replaces a swapped router on the same port", async () => {
  const nineRoutes = nineRouterRoutes();
  const omniRoutes = omniRouteRoutes({ models: [{ id: "auto/coding:fast", object: "model" }] });
  let current = nineRoutes;
  const server = await serve(new Proxy({}, { get: (_target, key) => current[key] }));
  const { controller } = makeController({ XDG_CONFIG_HOME: tempDir(), OMR_ROUTER_DISCOVERY: "1", OMR_ROUTER_PORTS: String(server.port) });
  await controller.startRouterDiscovery(false);
  assert.ok(controller.providers.some((provider) => provider.id === "9router"));
  current = omniRoutes;
  await controller.startRouterDiscovery(true);
  assert.equal(controller.providers.some((provider) => provider.id === "9router"), false);
  const omni = controller.providers.find((provider) => provider.id === "omniroute");
  assert.deepEqual(omni.models.map((model) => model.id), ["auto/coding:fast"]);
});

test("closing the picker cancels discovery without late updates", async () => {
  const hanging = await serve({ "GET /api/health": "hang" });
  const { controller, calls } = makeController({ XDG_CONFIG_HOME: tempDir(), OMR_ROUTER_DISCOVERY: "1", OMR_ROUTER_PORTS: String(hanging.port) });
  const job = controller.startRouterDiscovery(false);
  await sleep(50);
  controller.cancelRouterDiscovery();
  const before = calls.length;
  await sleep(600);
  assert.equal(calls.length, before);
  await controller.whenRouterDiscoveryIdle();
  await job;
});

test("an unsaved router that disappears is removed unless it is the active provider", async () => {
  const detect = async () => {
    const server = await startServer(nineRouterRoutes());
    const made = makeController({ XDG_CONFIG_HOME: tempDir(), OMR_ROUTER_DISCOVERY: "1", OMR_ROUTER_PORTS: String(server.port), OMR_MODEL: "gpt-4.1", OPENAI_API_KEY: "k", OPENAI_BASE_URL: "http://127.0.0.1:9/v1" });
    await made.controller.startRouterDiscovery(false);
    assert.ok(made.controller.providers.some((provider) => provider.id === "9router"));
    return { ...made, server };
  };
  const gone = await detect();
  await gone.server.close();
  await gone.controller.startRouterDiscovery(true);
  assert.equal(gone.controller.providers.some((provider) => provider.id === "9router"), false);

  const active = await detect();
  await active.controller.applyModelSelection("9router", "cx/example-model", false);
  await active.server.close();
  await active.controller.startRouterDiscovery(true);
  const kept = active.controller.providers.find((provider) => provider.id === "9router");
  assert.equal(kept.catalogStatus, "offline");
  assert.equal(kept.models.length, 3);
});

test("env-configured routers resolve synchronously at startup", async () => {
  const nine = await serve(nineRouterRoutes());
  const env = { XDG_CONFIG_HOME: tempDir(), OMR_OMNIROUTE_BASE_URL: `${nine.origin}/v1`, OMR_OMNIROUTE_API_KEY: "ko", OMR_ROUTER_DISCOVERY: "0" };
  const providers = discoverProvidersSync(env, null);
  const omni = providers.find((provider) => provider.id === "omniroute");
  assert.equal(omni.provenance, "env-router");
  assert.equal(omni.apiKey, "ko");
  assert.equal(omni.product, "omniroute");
  const info = resolveModelConfig(env, "omniroute:auto/coding:fast");
  assert.equal(info.config.providerId, "omniroute");
  assert.equal(info.config.model, "auto/coding:fast");
  assert.equal(info.config.baseUrl, `${nine.origin}/v1`);
  assert.equal(nine.requests.length, 0);
});

test("named-provider duplicates from older saves are not rebuilt and never get OPENAI_API_KEY", async () => {
  const nine = await serve(nineRouterRoutes());
  const dir = tempDir();
  const env = { XDG_CONFIG_HOME: dir, OPENAI_API_KEY: "sk-leak" };
  const named = `${nine.origin}/v1`;
  const top = named.replace("127.0.0.1", "localhost");
  const stored = { provider: "9router", model: "cx/example-model", base_url: top, api_key_env: "OPENAI_API_KEY", providers: { "9router": { name: "9Router", base_url: named, protocol: "openai-chat", router: "9router" } } };
  const providers = discoverProvidersSync(env, stored);
  assert.equal(providers.some((provider) => provider.id === "custom"), false);
  const router = providers.find((provider) => provider.id === "9router");
  assert.equal(router.apiKey, "");
  assert.equal(router.provenance, "config-named");
  assert.equal(router.product, "9router");
  await refreshAllProviders(providers.filter((provider) => provider.local));
  assert.equal(nine.requests.some((request) => JSON.stringify(request.headers).includes("sk-leak")), false);
});

const routerEntry = (id, product, status, count = 0) => ({
  id, name: ROUTER_PRODUCTS[product].name, protocol: "openai-chat", baseUrl: `http://127.0.0.1:${product === "9router" ? 20128 : 20127}/v1`,
  connected: true, local: true, apiKey: "", apiKeyEnv: "", keySource: "local (no key)", envHint: "", headers: {},
  models: Array.from({ length: count }, (_, i) => ({ id: `cx/model-${i}`, label: `cx/model-${i}`, source: "live" })),
  liveLoaded: true, error: null, provenance: "detected", product, catalogStatus: status,
});

const pickerFor = async (language) => {
  const i18n = new I18n();
  await i18n.initialize(language, { XDG_CONFIG_HOME: tempDir() });
  const base = discoverProvidersSync({ OPENAI_API_KEY: "sk-render-secret" }, null);
  const providers = [
    base.find((provider) => provider.id === "openai"),
    routerEntry("9router", "9router", "ok", 37),
    routerEntry("omniroute", "omniroute", "auth-required"),
    base.find((provider) => provider.id === "ollama"),
  ];
  const ui = new TerminalUi({
    i18n, commands: COMMANDS, theme: createTheme({ COLORTERM: "truecolor", TERM: "xterm-256color" }),
    providers: () => providers, onSubmit: () => {}, onInterrupt: () => {}, onExit: () => {},
  });
  return { ui, providers };
};
const frameText = (ui, cols, rows) => ui.renderFrame(cols, rows).lines.map(stripAnsi).join("\n");

test("picker renders router statuses within width in English and Turkish", async () => {
  for (const [language, auth, scanning] of [
    ["en", "API key required", "Checking local routers…"],
    ["tr", "API anahtarı gerekiyor", "Yerel yönlendiriciler denetleniyor…"],
  ]) {
    const { ui, providers } = await pickerFor(language);
    ui.openModelPicker(providers, "openai", "gpt-4.1", null, false, "auto");
    ui.updateModelPicker({ scanning: true });
    for (const [cols, rows] of [[54, 15], [80, 24], [120, 36], [136, 38]]) {
      for (const line of ui.renderFrame(cols, rows).lines) assert.ok(visibleWidth(line) <= cols, `${language} ${cols}: ${stripAnsi(line)}`);
    }
    assert.match(frameText(ui, 80, 24), new RegExp(scanning));
    ui.updateModelPicker({ scanning: false });
    const list = frameText(ui, 120, 36);
    assert.match(list, /9Router/);
    assert.match(list, /KEY\?/);
    assert.equal(list.includes("sk-render-secret"), false);
    for (let i = 0; i < 3; i += 1) ui.handleKey("\t");   // All -> openai -> 9router -> omniroute
    assert.match(frameText(ui, 120, 36), new RegExp(auth));
    for (const [cols, rows] of [[54, 15], [80, 24], [120, 36], [136, 38]]) {
      for (const line of ui.renderFrame(cols, rows).lines) assert.ok(visibleWidth(line) <= cols);
    }
  }
});

test("the All tab is still the default and keeps provider prefixes", async () => {
  const { ui, providers } = await pickerFor("en");
  ui.openModelPicker(providers, "openai", "gpt-4.1", null, false, "auto");
  const wide = frameText(ui, 120, 36);
  assert.match(wide, /▸◈ All Connected/);
  assert.match(wide, /openai:gpt-4\.1/);
  assert.match(wide, /9router:cx\/model-0/);
  assert.match(frameText(ui, 60, 18), /openai:/);
});
