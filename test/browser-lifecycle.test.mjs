import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BrowserManager } from "../dist/browser.js";

const withBrowser = async (fn, env = {}) => {
  const root = await mkdtemp(join(tmpdir(), "omr-browser-lifecycle-"));
  const requests = [];
  let seen;
  const firstRequest = new Promise(r => {seen = r;});
  const server = createServer((req, res) => {
    requests.push(req.url); seen();
    if (req.url.startsWith("/health")) {res.writeHead(200, {"content-type": "application/json"}); res.end('{"ok":true}');}
    // Deliberately leave tool responses open. Tests must cancel rather than wait for a server response.
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const manager = new BrowserManager(root, {CAMOFOX_BASE_URL: `http://127.0.0.1:${server.address().port}`, CAMOFOX_USER_ID: "fixture", CAMOFOX_SESSION_KEY: "fixture-session", ...env});
  manager.ensureCamofoxRunning = async (signal) => {signal?.throwIfAborted(); return {reachable: true};};
  try {await fn({manager, requests, firstRequest});}
  finally {server.closeAllConnections(); await new Promise(r=>server.close(r)); await rm(root, {recursive:true,force:true});}
};

describe("B14/B15: browser routing and cancellation contracts", () => {
  it("does not start browser work for an already-aborted request", async () => {
    await withBrowser(async ({manager, requests}) => {
      const result = await manager.call("omr_browser", {action:"open",url:"https://fixture.invalid"}, AbortSignal.abort());
      assert.equal(result.isError, true);
      assert.equal(result.payload.__error.code, "CANCELLED");
      assert.equal(requests.length, 0);
    });
  });
  it("forwards abort through omr_browser to its in-flight HTTP request", async () => {
    await withBrowser(async ({manager, firstRequest}) => {
      const abort = new AbortController();
      const pending = manager.call("omr_browser", {action:"open",url:"https://fixture.invalid"}, abort.signal);
      await firstRequest;
      abort.abort();
      const result = await pending;
      assert.equal(result.isError, true);
      assert.equal(result.payload.__error.code, "CANCELLED");
    });
  });
  it("uses one deadline for JSON and screenshot HTTP calls", async () => {
    await withBrowser(async ({manager}) => {
      for (const tool of ["camofox_create_tab", "camofox_screenshot"]) {
        const result = await manager.call(tool, {url:"https://fixture.invalid",tabId:"fixture"});
        assert.equal(result.isError, true);
        assert.equal(result.payload.__error.code, "TIMEOUT");
      }
    }, {OMR_BROWSER_TIMEOUT_MS:"40"});
  });
  it("reports Camofox proxy capability honestly and never navigates with unapplied routing", async () => {
    await withBrowser(async ({manager, requests}) => {
      const preference = manager.setProxyMode("socks5://127.0.0.1:9050");
      assert.equal(preference.scope, "local-browser-launch");
      assert.equal(preference.camofoxRouting.supported, false);
      const result = await manager.call("camofox_create_tab", {url:"https://fixture.invalid"});
      assert.equal(result.isError, true);
      assert.match(result.text, /routing.*unsupported|unsupported.*routing/i);
      assert.equal(requests.length, 0);
    });
  });
});
