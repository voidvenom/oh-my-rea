import assert from "node:assert/strict";
import { after, test } from "node:test";
import { boundedGet } from "../dist/boundedHttp.js";
import { customProviderId, parseKeyInput, sameEndpoint, validateCustomBaseUrl } from "../dist/customEndpoint.js";
import { DISCOVERY_LIMITS, discoverLocalRouters, fetchCatalog, identifyRouter, routerCandidates } from "../dist/localRouters.js";
import { lookupModelsDev, slimModelsDev } from "../dist/modelLimits.js";
import { BUILTIN_PROVIDERS, extractLiveModelsFromPayload } from "../dist/providers.js";
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
  assert.equal((await boundedGet(`${closed.origin}/x`, { timeoutMs: 1000, maxBytes: 1024 })).kind, "unreachable");
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
