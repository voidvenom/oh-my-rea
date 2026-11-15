import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { BrowserManager } from "../dist/browser.js";
import { ReaBroker } from "../dist/broker.js";
import { createSession, forkSession } from "../dist/session.js";
import { parseArgs } from "../dist/args.js";
import { OmrContext } from "../dist/runtime/context.js";
import { OutputSink } from "../dist/runtime/output.js";
import { FakeModel, FakeRea } from "../dist/testing/fakes.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const fixture = async () => {
  const tabs = new Map([["external", "https://external.test/"]]); const requests = []; const deleted = []; let count = 0;
  const control = { beforeSnapshot: async () => {} };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://fixture").pathname; requests.push(`${req.method} ${path}`);
      let body = ""; for await (const chunk of req) body += chunk;
      const args = body ? JSON.parse(body) : {};
      const json = value => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (path === "/health") return json({ ok: true, browserRunning: true });
      if (path === "/tabs" && req.method === "POST") { const tabId = `owned-${++count}`; tabs.set(tabId, args.url); return json({ tabId, url: args.url }); }
      if (path === "/tabs") return json({ tabs: [...tabs].map(([tabId, url]) => ({ tabId, url })) });
      const tabId = path.split("/")[2];
      if (path.endsWith("/snapshot")) { await control.beforeSnapshot(); return json({ url: tabs.get(tabId), snapshot: "button e1: fixture", hasMore: false, screenshot: { data: png }, saved_screenshot_path: "/untrusted/server/path.png" }); }
      if (path.endsWith("/screenshot")) { res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.from(png, "base64")); return; }
      if (path.endsWith("/navigate")) { tabs.set(tabId, args.url); return json({ ok: true }); }
      if (req.method === "DELETE") { deleted.push(tabId); tabs.delete(tabId); return json({ ok: true }); }
      json({ ok: true });
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { env: { CAMOFOX_BASE_URL: `http://127.0.0.1:${server.address().port}`, CAMOFOX_USER_ID: "fixture" }, tabs, requests, deleted, control,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
};
const manager = (root, env) => { const browser = new BrowserManager(root, env); browser.ensureCamofoxRunning = async () => ({ reachable: true }); return browser; };

describe("durable browser context and ownership", () => {
  it("keeps DOM/screenshot hashes, attaches vision and closes only owned remote tabs", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-browser-context-")); const http = await fixture(); let browser;
    try {
      browser = manager(root, http.env); const broker = new ReaBroker(new FakeRea(root), { browser });
      await browser.call("camofox_create_tab", { url: "https://fixture.test/" });
      await browser.call("camofox_list_tabs", {});
      assert.equal(browser.context.read().activeTabId, "owned-1", "listing silently changed selection");
      assert.equal((await browser.call("omr_browser", { action: "select", tabId: "external" })).isError, false);
      assert.match(browser.contextNote(), /observed only/);
      const outcome = await broker.dispatch("camofox_snapshot", { tabId: "owned-1" });
      assert.equal(outcome.isError, false, outcome.text); assert.equal(outcome.images.length, 1);
      const state = browser.context.read(); const tab = state.tabs.find(tab => tab.id === "owned-1");
      assert.equal(tab.ownership.baseUrl,http.env.CAMOFOX_BASE_URL);assert.equal(tab.ownership.userId,"fixture");assert.equal(tab.ownership.runId,browser.context.runId);assert.equal("accessKey" in tab.ownership,false);assert.equal("apiKey" in tab.ownership,false);
      assert.ok(tab.capture.path.startsWith(root));
      assert.equal(createHash("sha256").update(await readFile(tab.capture.path)).digest("hex"), tab.capture.sha256);
      assert.equal(createHash("sha256").update(await readFile(tab.lastScreenshot.path)).digest("hex"), tab.lastScreenshot.sha256);
      assert.ok(tab.lastScreenshot.path.startsWith(join(root, "screenshots")), "server supplied an arbitrary local image path");
      await browser.call("camofox_click", { tabId: "owned-1", ref: "e1" });
      await browser.call("camofox_screenshot", { tabId: "owned-1" });
      assert.equal(browser.context.read().tabs.find(tab => tab.id === "owned-1").status, "stale", "screenshot incorrectly refreshed DOM refs");
      assert.match(browser.contextNote(), /fresh snapshot/);
      await browser.close(); assert.deepEqual(http.deleted, ["owned-1"]); assert.equal(http.tabs.has("external"), true);
      await browser.close(); assert.deepEqual(http.deleted, ["owned-1"]);
    } finally { await browser?.close(); await http.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("serializes snapshot and navigation so late responses cannot publish fresh stale refs", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-browser-order-")); const http = await fixture(); let browser, release;
    try {
      browser = manager(root, http.env); await browser.call("camofox_create_tab", { url: "https://fixture.test/old" });
      let started; const observed = new Promise(resolve => { started = resolve; }); const gate = new Promise(resolve => { release = resolve; });
      http.control.beforeSnapshot = async () => { started(); await gate; };
      const snapshot = browser.call("camofox_snapshot", { tabId: "owned-1" }); await observed;
      const navigation = browser.call("camofox_navigate", { tabId: "owned-1", url: "https://fixture.test/new" });
      await delay(10); assert.equal(http.requests.some(request => request.endsWith("/navigate")), false);
      release(); await snapshot; await navigation;
      const tab = browser.context.read().tabs.find(tab => tab.id === "owned-1");
      assert.equal(tab.url, "https://fixture.test/new"); assert.equal(tab.status, "stale");
      assert.match(JSON.parse(await readFile(tab.capture.path, "utf8")).url, /old$/);
    } finally { release?.(); await browser?.close(); await http.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("retains independent fork artifacts while restoring historical context without ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-browser-fork-")); const http = await fixture(); let original, restored;
    try {
      const session = await createSession(null, "fixture", { rootDir: root }); original = manager(session.dir, http.env);
      await original.call("camofox_create_tab", { url: "https://fixture.test/" }); await original.call("camofox_snapshot", { tabId: "owned-1" });
      const fork = await forkSession(session, [], null, "fixture", { rootDir: root });
      await original.close(); await rm(session.dir, { recursive: true, force: true });
      restored = manager(fork.dir, http.env); await restored.context.initialize();
      const state = restored.context.read(); assert.equal(state.activeTabId, null); assert.deepEqual(restored.context.ownedTabIds(), []);
      assert.equal(state.tabs[0].status, "historical"); assert.ok(state.tabs[0].capture.path.startsWith(fork.dir));
      assert.equal(state.tabs[0].ownerRunId,null);assert.equal(state.tabs[0].ownership.runId,original.context.runId);assert.equal(state.tabs[0].ownership.baseUrl,http.env.CAMOFOX_BASE_URL);
      await readFile(state.tabs[0].capture.path); await readFile(state.tabs[0].lastScreenshot.path);
      assert.equal((await restored.call("omr_browser", { action: "select", tabId: "owned-1" })).isError, true, "historical context was silently reattached");
      await restored.close(); assert.deepEqual(http.deleted, ["owned-1"]);
    } finally { await original?.close(); await restored?.close(); await http.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("feeds actual runtime model turns with browser vision and persistent selected-tab context", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-browser-model-")); const http = await fixture(); let ctx;
    const model = new FakeModel([{ toolCalls: [{ name: "camofox_create_tab", arguments: { url: "https://fixture.test/" } }] }, { toolCalls: [{ name: "camofox_snapshot", arguments: { tabId: "owned-1" } }] }, { content: "observed fixture" }, { content: "continued fixture" }]);
    try {
      const session = await createSession(null, "fixture", { rootDir: root });
      ctx = new OmrContext({ opts: parseArgs(["node", "omr", "--json"]), cwd: root, env: { ...http.env, OPENAI_API_KEY: "fixture", OMR_MODEL: "gpt-4.1" }, sources: [], session, sessionsRootDir: root, currentTarget: null, currentMagic: null,
        output: new OutputSink({ json: true, writeStdout: () => {}, writeStderr: () => {} }), deps: { connectRea: async dir => new FakeRea(dir), createModelClient: () => model } });
      ctx.browserManager.ensureCamofoxRunning = async () => ({ reachable: true });
      await ctx.runTurn("inspect the browser fixture", "fixture");
      assert.ok(model.requests[2].messages.some(message => message.images?.length), "browser screenshot did not reach the next model step");
      await ctx.runTurn("continue", "fixture");
      assert.match(JSON.stringify(model.requests[3].messages), /active Camofox tab owned-1/);
      assert.match(JSON.stringify(model.requests[3].messages), /snapshot preview/);
      await ctx.shutdown("complete"); ctx = null; assert.deepEqual(http.deleted, ["owned-1"]);
    } finally { await ctx?.shutdown("complete"); await http.close(); await rm(root, { recursive: true, force: true }); }
  });
});
