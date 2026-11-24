import { createServer } from "node:http";

/**
 * Ephemeral loopback servers. `routes` maps "GET /path" to a response object, a function returning one
 * (sync or async) or the string "hang" (never answers). Every request is recorded in `requests`.
 */
export const startServer = async (routes, host = "127.0.0.1") => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    requests.push({ method: req.method, path: url.pathname, search: url.search, headers: { ...req.headers } });
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"not found"}');
      return;
    }
    const out = typeof route === "function" ? await route(req, url) : route;
    if (out === "hang") return;
    const raw = out.body;
    const body = typeof raw === "string" || Buffer.isBuffer(raw) ? raw : JSON.stringify(raw ?? {});
    res.writeHead(out.status ?? 200, { "content-type": "application/json", ...out.headers });
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address();
  const origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  return {
    origin,
    port,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
};

export const defaultModels = () => [
  { id: "cx/example-model", object: "model", owned_by: "cx", context_length: 64000, max_completion_tokens: 8000 },
  { id: "cx/example-model:thinking", object: "model", owned_by: "cx" },
  { id: "example-combo", object: "model", owned_by: "combo" },
];

const listBody = (models) => ({ object: "list", data: models });
const failure = (status) => ({ status, body: { error: { message: "fixture failure" } } });

export const nineRouterRoutes = ({ models = defaultModels(), catalogStatus = 200, requireKey } = {}) => ({
  "GET /api/health": { body: { ok: true } },
  "GET /api/settings/require-login": { body: { requireLogin: false, tunnelDashboardAccess: false } },
  "GET /v1/models": (req) => {
    if (requireKey && req.headers.authorization !== `Bearer ${requireKey}`) return failure(401);
    return catalogStatus === 200 ? { body: listBody(models) } : failure(catalogStatus);
  },
});

export const omniRouteRoutes = ({ models = defaultModels(), pages, catalogStatus = 200, requireKey, cardUrl } = {}) => ({
  "GET /api/health": { body: { status: "ok", timestamp: "2026-01-01T00:00:00.000Z" } },
  "GET /.well-known/agent.json": {
    body: { name: "OmniRoute AI Gateway", capabilities: {}, skills: [], ...(cardUrl ? { url: cardUrl } : {}) },
  },
  "GET /v1/models": (req, url) => {
    if (requireKey && req.headers.authorization !== `Bearer ${requireKey}`) return failure(401);
    if (catalogStatus !== 200) return failure(catalogStatus);
    if (!pages) return { body: listBody(models) };
    const after = url.searchParams.get("after");
    const index = after === null ? 0 : pages.findIndex((page) => page.at(-1)?.id === after) + 1;
    const page = pages[index] ?? [];
    const more = index + 1 < pages.length;
    return { body: { ...listBody(page), ...(more ? { has_more: true, last_id: page.at(-1)?.id } : { has_more: false }) } };
  },
});

export const genericOpenAiRoutes = ({ models = defaultModels() } = {}) => ({
  "GET /v1/models": { body: listBody(models) },
  "GET /api/health": { body: { ok: true } },
  "GET /health": { body: { status: "ok" } },
});

export const ipv6Available = async () => {
  try {
    const server = await startServer({}, "::1");
    await server.close();
    return true;
  } catch {
    return false;
  }
};
