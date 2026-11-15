// Optional integration check: installed Chromium + local REA, no model/API credentials.
// All application traffic and files belong to this disposable localhost fixture.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { abortable } from "../dist/concurrency.js";
import { Rea } from "../dist/rea.js";
import { createSession } from "../dist/session.js";
import { SessionRuntime } from "../dist/runtime/sessionRuntime.js";

const root = await mkdtemp(join(tmpdir(), "omr-live-episode-"));
const abort = new AbortController(); const timer = setTimeout(() => abort.abort(new Error("Live episode deadline exceeded")), 45_000); timer.unref();
let runtime, rea, run, browserPid, stage = "fixture", requestCount = 0, ready;
let browserProcesses=[];
const ownedGroup=async pid=>{if(process.platform!=="linux"||!pid)return[];const rows=await Promise.all((await readdir("/proc")).filter(name=>/^\d+$/.test(name)).map(async name=>{try{const text=await readFile(`/proc/${name}/stat`,"utf8");const fields=text.slice(text.lastIndexOf(")")+2).split(" ");return Number(fields[2])===pid&&fields[0]!=="Z"?Number(name):null;}catch{return null;}}));return rows.filter(Boolean);};
const appReady = new Promise(resolve => { ready = resolve; });
const source = 'const button=document.querySelector("button"); setInterval(()=>fetch("/api/ping").then(response=>response.json()).then(value=>{button.textContent=value.message}),100); export const endpoint="/api/ping";';
const server = createServer((req, res) => {
  if (req.url === "/api/ping") { requestCount++; ready(); res.writeHead(200, { "content-type": "application/json" }); res.end('{"message":"fixture observed"}'); }
  else if (req.url === "/app.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(source); }
  else if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end('<!doctype html><title>OMR controlled fixture</title><button>fixture</button><script type="module" src="/app.js"></script>'); }
  else { res.writeHead(404); res.end(); }
});
let report;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const env = { PATH: process.env.PATH, ...(process.env.OMR_REA_COMMAND ? { OMR_REA_COMMAND: process.env.OMR_REA_COMMAND } : {}) };
  const session = await createSession(null, null, { rootDir: root });
  runtime = new SessionRuntime(session, env, () => ({ cancelAll: async () => {} }));
  stage = "rea-connect"; rea = await Rea.connect(session.dir, env, [], { signal: abort.signal, toolTimeoutMs: 30_000 }); runtime.attachRea(rea);
  stage = "owned-browser"; const browser = await runtime.browser.launchLocalBrowser({ engine: "chromium", headless: true, url }, abort.signal);
  browserPid = browser.pid;
  await abortable(appReady, abort.signal);
  stage = "cdp-target";
  const discovery = await runtime.rea.call("list_browser_targets", { cdp_endpoint: browser.cdpUrl }, { signal: abort.signal });
  assert.equal(discovery.isError, false, discovery.text);
  const targets = (discovery.payload.normalized_result ?? discovery.payload).targets;
  const matching = targets.filter(target => target.url === url); assert.equal(matching.length, 1, "fixture target was not uniquely identified");
  stage = "recipe";
  run = await runtime.recipes.run("browser-javascript", { target_id: matching[0].target_id, min_network_requests: 1, observation_ms: 500, analysis_timeout_ms: 10_000, max_heap_mb: 256 }, abort.signal);
  assert.equal(run.status, "completed", run.problem);
  stage = "proof"; assert.equal(await runtime.recipes.resolveProof(run.id), true);
  browserProcesses=await ownedGroup(browserPid);if(process.platform==="linux")assert.ok(browserProcesses.length>1,"Expected owned Chromium descendants in the process group");
  report = { passed: true, status: run.status, recipe: run.recipe, version: run.version, recipeSha256: run.recipeSha256, implementationSha256: run.implementationSha256,
    steps: run.steps.map(step => ({ id: step.id, tool: step.tool, evidenceId: step.evidenceId })), exitConditions: run.exitConditions, browserCoverage: run.coverage.browser,
    javascriptCoverage: run.coverage.javascript.coverage, javascriptUnknowns: run.coverage.javascript.unknowns,
    screenshotBytes: run.artifacts.find(artifact => artifact.kind === "screenshot-png").bytes,
    exportedSourceFiles: run.artifacts.filter(artifact => artifact.kind === "javascript-source").length, fixtureRequests: requestCount, cleanup: "pending" };
} catch (error) { report = { passed: false, stage, error: error instanceof Error ? error.message : String(error), ...(run ? { receipt: { status: run.status, steps: run.steps.map(step => ({ id: step.id, tool: step.tool, evidenceId: step.evidenceId })), exitConditions: run.exitConditions, coverage: run.coverage } } : {}), cleanup: "pending" }; process.exitCode = 1; }
finally {
  clearTimeout(timer);
  try {
    if (runtime) await runtime.close(); else await rea?.close();
    const alive = () => { if (!browserPid) return false; try { process.kill(browserPid, 0); return true; } catch { return false; } };
    for (let attempt = 0; attempt < 20 && alive(); attempt++) await delay(25);
    assert.equal(alive(), false, "owned Chromium process survived cleanup");assert.deepEqual(await ownedGroup(browserPid),[],"Owned Chromium descendants survived cleanup");report.ownedBrowserProcessesObserved=browserProcesses.length;report.cleanup = "completed";
  }
  catch (error) { report.cleanup = String(error); report.passed = false; process.exitCode = 1; }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
const reportIndex = process.argv.indexOf("--report");
if (reportIndex >= 0) { if (!process.argv[reportIndex + 1]) throw new Error("--report requires a path"); await writeFile(resolve(process.argv[reportIndex + 1]), `${JSON.stringify(report, null, 2)}\n`); }
console.log(JSON.stringify(report));
