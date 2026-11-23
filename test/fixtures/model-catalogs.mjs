import { after, before, mock } from "node:test";

/** Supply catalog metadata for integration tests that already use fake model turns. */
export const useModelCatalogFixtures = () => {
  let fetchMock;
  before(() => {
    const fetchLoopback = globalThis.fetch;
    fetchMock = mock.method(globalThis, "fetch", async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "api.openai.com" && url.pathname === "/v1/models") {
        return Response.json({ data: [{ id: "gpt-4.1", context_window: 128_000 }] });
      }
      if (url.hostname === "api.anthropic.com" && ["/models", "/v1/models"].includes(url.pathname)) {
        return Response.json({ data: [{ id: "claude-sonnet-4-6", context_window: 200_000 }] });
      }
      if (url.hostname === "127.0.0.1" && ["11434", "1234", "8000", "8080", "8081"].includes(url.port)
          && ["/api/tags", "/v1/models", "/models"].includes(url.pathname)) {
        return new Response(null, { status: 404 });
      }
      return fetchLoopback(input, init);
    });
  });
  after(() => fetchMock?.mock.restore());
};
