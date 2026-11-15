import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseCapabilityMetadata } from "../dist/capabilities.js";
import { limitsCacheKey, lookupModelsDev, resolveLimits, slimModelsDev } from "../dist/modelLimits.js";

const modelsDev = {
  deepseek: { models: { "deepseek-v4-pro": { limit: { context: 1048576, output: 393216 } }, "no-limit": {} } },
  google: { models: { "gemini-2.5-pro": { limit: { context: 1048576, output: 65536 } } } },
};
const fakeFetch = (counter) => async (url) => {
  counter.n += 1;
  assert.equal(String(url), "https://models.dev/api.json");
  return { ok: true, status: 200, json: async () => modelsDev };
};
const sandbox = () => { const dir = mkdtempSync(join(tmpdir(), "omr-limits-")); return { dir, env: { XDG_CONFIG_HOME: dir }, done: () => rmSync(dir, { recursive: true, force: true }) }; };

test("parseCapabilityMetadata reads OpenAI-style max_completion_tokens, capabilities.maxOutput and max_context_length", () => {
  assert.deepEqual(parseCapabilityMetadata({ context_length: 1_000_000, max_completion_tokens: 128_000 }), { contextWindow: 1_000_000, maxOutputTokens: 128_000 });
  assert.deepEqual(parseCapabilityMetadata({ capabilities: { contextWindow: 200_000, maxOutput: 64_000 } }), { contextWindow: 200_000, maxOutputTokens: 64_000 });
  assert.equal(parseCapabilityMetadata({ max_context_length: 32_768 }).contextWindow, 32_768);
  assert.deepEqual(parseCapabilityMetadata({ id: "x" }), {});
});

test("slimModelsDev keeps only models with a context limit; lookup is exact and provider-mapped", () => {
  const index = slimModelsDev(modelsDev);
  assert.deepEqual(lookupModelsDev(index, "deepseek", "deepseek-v4-pro"), { contextWindow: 1048576, maxOutputTokens: 393216 });
  assert.deepEqual(lookupModelsDev(index, "gemini", "gemini-2.5-pro"), { contextWindow: 1048576, maxOutputTokens: 65536 }); // omr "gemini" → models.dev "google"
  assert.equal(lookupModelsDev(index, "deepseek", "no-limit"), null);
  assert.equal(lookupModelsDev(index, "deepseek", "deepseek-v4"), null, "no prefix/fuzzy matching");
  assert.equal(lookupModelsDev(index, "custom", "deepseek-v4-pro"), null, "gateways are never matched by model name alone");
  assert.equal(lookupModelsDev(index, "ollama", "deepseek-v4-pro"), null, "local servers are not matched to model maximums");
});

test("live endpoint metadata wins; models.dev is not even fetched when the endpoint reports a window", async () => {
  const box = sandbox(); const counter = { n: 0 };
  const result = await resolveLimits("custom", "https://gw/v1", "m", { env: box.env, fetchImpl: fakeFetch(counter), live: async () => ({ contextWindow: 1_000_000, maxOutputTokens: 128_000 }) });
  assert.deepEqual(result, { metadata: { contextWindow: 1_000_000, maxOutputTokens: 128_000 }, origin: "provider" });
  assert.equal(counter.n, 0);
  const cache = JSON.parse(readFileSync(join(box.dir, "rea", "omr-limits.json"), "utf8"));
  assert.equal(cache.entries[limitsCacheKey("custom", "https://gw/v1", "m")].contextWindow, 1_000_000);
  box.done();
});

test("falls back to models.dev when the endpoint is silent, and caches both the index and the result", async () => {
  const box = sandbox(); const counter = { n: 0 }; let liveCalls = 0;
  const sources = { env: box.env, fetchImpl: fakeFetch(counter), live: async () => { liveCalls += 1; return undefined; } };
  const first = await resolveLimits("deepseek", "https://api.deepseek.com", "deepseek-v4-pro", sources);
  assert.deepEqual(first, { metadata: { contextWindow: 1048576, maxOutputTokens: 393216 }, origin: "models.dev" });
  const second = await resolveLimits("deepseek", "https://api.deepseek.com", "deepseek-v4-pro", sources);
  assert.equal(second?.origin, "cache");
  assert.equal(liveCalls, 1, "fresh cache skips the live lookup");
  assert.equal(counter.n, 1, "models.dev fetched once");
  box.done();
});

test("unknown model: returns null instead of guessing, and a failing live lookup is not fatal", async () => {
  const box = sandbox(); const counter = { n: 0 };
  assert.equal(await resolveLimits("deepseek", "u", "not-a-real-model", { env: box.env, fetchImpl: fakeFetch(counter), live: async () => undefined }), null);
  assert.equal(await resolveLimits("custom", "u", "m", { env: box.env, fetchImpl: fakeFetch(counter), live: async () => { throw new Error("down"); } }), null);
  box.done();
});

test("offline models.dev with no cache yields null; a stale index is still used", async () => {
  const box = sandbox();
  const offline = async () => { throw new Error("offline"); };
  assert.equal(await resolveLimits("deepseek", "u", "deepseek-v4-pro", { env: box.env, fetchImpl: offline, live: async () => undefined }), null);
  await resolveLimits("deepseek", "u", "deepseek-v4-pro", { env: box.env, fetchImpl: fakeFetch({ n: 0 }), live: async () => undefined, now: () => 0 });
  const stale = await resolveLimits("deepseek", "u2", "deepseek-v4-pro", { env: box.env, fetchImpl: offline, live: async () => undefined, now: () => 30 * 24 * 3600 * 1000 });
  assert.equal(stale?.metadata.contextWindow, 1048576);
  box.done();
});
