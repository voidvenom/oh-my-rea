import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "../dist/args.js";
import { createSession, forkSession, saveSessionHistory } from "../dist/session.js";
import { OmrContext } from "../dist/runtime/context.js";
import { OutputSink } from "../dist/runtime/output.js";
import { createDefaultCommandRegistry } from "../dist/runtime.js";
import { FakeModel, FakeRea } from "../dist/testing/fakes.js";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { ExecutionStore, readExecutionEvents } from "../dist/execution.js";

const ev = `ev_${"a".repeat(64)}`;
const makeContext = async (root, connectRea = async dir=>new FakeRea(dir)) => {
  const session = await createSession(null,"fixture",{rootDir:root});
  const ctx = new OmrContext({opts:parseArgs(["node","omr","--json"]),cwd:root,env:{OPENAI_API_KEY:"fixture",OMR_MODEL:"gpt-4.1"},sources:[],session, sessionsRootDir:root,
    currentTarget:null,currentMagic:null,output:new OutputSink({json:true,writeStdout:()=>{},writeStderr:()=>{}}),deps:{connectRea,createModelClient:()=>new FakeModel([{content:"finding"}])}});
  return ctx;
};

describe("B02: session runtime owns every bound component", () => {
  it("closes the old backend and replaces browser, workers and journal on fork", async () => {
    const root = await mkdtemp(join(tmpdir(),"omr-session-runtime-")); let ctx;
    try {
      ctx = await makeContext(root); await ctx.ensureConnected();
      const oldRea=ctx.rea, oldBrowser=ctx.browserManager, oldWorkers=ctx.subagentRunner;
      const next = await forkSession(ctx.session,[],null,"fixture",{rootDir:root});
      await ctx.switchSession(next);
      assert.equal(oldRea.isClosed,true);
      assert.notEqual(ctx.browserManager,oldBrowser);
      assert.notEqual(ctx.subagentRunner,oldWorkers);
      await ctx.ensureConnected();
      assert.equal(ctx.rea.sessionDir,next.dir);
      assert.equal(ctx.browserManager.sessionDir,next.dir);
      assert.equal(ctx.runtime.binding.sessionId,next.id);
      assert.equal(ctx.runtime.session.id,next.id);
    } finally {await ctx?.shutdown("complete");await rm(root,{recursive:true,force:true});}
  });

  it("resumes through a fresh continuation directory and imports only catalog-supported Evidence", async () => {
    const root = await mkdtemp(join(tmpdir(),"omr-session-resume-")); let ctx;
    const imported=[];
    try {
      const source = await createSession(null,"fixture",{rootDir:root});
      await saveSessionHistory(source,[{role:"user",content:"original"},{role:"assistant",content:`finding ${ev}`}],null,"fixture");
      await writeFile(join(source.dir,"evidence-bundle.json"),JSON.stringify({records:[{evidence_id:ev}],unknowns:[]}));
      ctx=await makeContext(root,async dir=>new FakeRea(dir,{extraTools:[{name:"import_evidence_bundle",readOnly:false}],handlers:{import_evidence_bundle:async args=>{imported.push(args.path);return {records_added:1};}}}));
      await createDefaultCommandRegistry().dispatchSlashLine(ctx,`/resume ${source.id}`);
      assert.equal(imported.length,1);
      assert.notEqual(ctx.session.id,source.id);
      assert.equal(ctx.rea.sessionDir,ctx.session.dir);
      assert.equal(ctx.runtime.evidenceOrigin.sourceSessionId,source.id);
      assert.equal(ctx.runtime.evidenceOrigin.status,"imported");
      assert.ok(ctx.runtime.importedEvidenceIds.has(ev));
      const origin=JSON.parse(await readFile(join(ctx.session.dir,"origin.json"),"utf8"));
      assert.equal(origin.sourceSessionId,source.id);
      assert.equal(origin.status,"imported");
    } finally {await ctx?.shutdown("complete");await rm(root,{recursive:true,force:true});}
  });

  it("keeps unsupported or rejected imports unverified and excludes historical citations from live counts", async () => {
    const root = await mkdtemp(join(tmpdir(),"omr-session-origin-")); let ctx;
    try {
      const source = await createSession(null,"fixture",{rootDir:root});
      await saveSessionHistory(source,[{role:"user",content:"original"},{role:"assistant",content:`finding ${ev}`}],null,"fixture");
      await writeFile(join(source.dir,"evidence-bundle.json"),JSON.stringify({records:[{evidence_id:ev}]}));
      for (const supportsImport of [false,true]) {
        ctx = await makeContext(root,async dir=>new FakeRea(dir, supportsImport ? {
          extraTools:[{name:"import_evidence_bundle",readOnly:false}],handlers:{import_evidence_bundle:async()=>({isError:true,text:"bundle integrity failed",payload:{__error:{message:"bundle integrity failed"}},durationMs:0})},
        } : {}));
        await createDefaultCommandRegistry().dispatchSlashLine(ctx,`/resume ${source.id}`);
        assert.equal(ctx.runtime.evidenceOrigin.status,"unverified");
        assert.equal(ctx.evidenceSeen.has(ev),false);
        assert.equal(ctx.runtime.importedEvidenceIds.size,0);
        assert.match(ctx.runtime.evidenceNote(),/unverified/);
        await ctx.shutdown("complete"); ctx=null;
      }
    } finally {await ctx?.shutdown("complete");await rm(root,{recursive:true,force:true});}
  });
});

describe("R2: execution trace is integrated with the actual runtime", () => {
  it("records model, native, script, shell and browser work in one session trace", async () => {
    const root=await mkdtemp(join(tmpdir(),"omr-common-trace-"));let ctx;
    const server=createServer((_req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true,"tabs":[]}');});
    await new Promise(r=>server.listen(0,"127.0.0.1",r));
    try {
      ctx=await makeContext(root);
      // A controlled BrowserManager instance keeps this test independent of Docker and live services.
      ctx.browserManager.camofoxConfig={baseUrl:`http://127.0.0.1:${server.address().port}`,userId:"fixture",sessionKey:"fixture",accessKey:"",apiKey:"",cookiesDir:root,source:"fixture"};
      ctx.browserManager.ensureCamofoxRunning=async()=>({reachable:true});
      await ctx.runTurn("inspect fixture","fixture");
      await ctx.rea.call("search_strings",{query:"fixture"});
      const script=await ctx.broker.dispatch("omr_run",{script:"trace.py",code:"print('trace-ok')"});
      assert.equal(script.isError,false,script.text);
      await ctx.executeBangLine("!printf trace-shell");
      assert.equal((await ctx.browserManager.call("camofox_list_tabs",{})).isError,false);
      const events=[];for await (const event of readExecutionEvents(ctx.runtime.events.path)) events.push(event);
      assert.ok(events.some(e=>e.type==="model.request"));assert.ok(events.some(e=>e.type==="model.result"));
      const backends=new Set(events.filter(e=>e.type==="invocation.started").map(e=>e.data.backend));
      assert.deepEqual([...backends].sort(),["browser","rea","script","shell"]);
      assert.ok(events.every(e=>e.sessionId===ctx.session.id));
    } finally {await ctx?.shutdown("complete");server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
  });

  it("does not automatically resume uncertain effects and permits an explicit reconciliation", async () => {
    const root=await mkdtemp(join(tmpdir(),"omr-reconcile-runtime-"));let ctx;let modelCalls=0;
    try {
      const source=await createSession(null,"fixture",{rootDir:root});
      await saveSessionHistory(source,[{role:"user",content:"continue old task"}],null,"fixture",{inFlight:true});
      const store=new ExecutionStore(source.id,source.dir);
      await assert.rejects(store.invoke({backend:"script",tool:"effect",args:{x:1},readOnly:false,binding:{target:null}},async()=>{throw new Error("lost result after effect");}));
      ctx=await makeContext(root);ctx.modelController.buildActiveClient=()=>new FakeModel(async()=>{modelCalls++;return {content:"verified continuation"};});
      const registry=createDefaultCommandRegistry();
      await registry.dispatchSlashLine(ctx,`/resume ${source.id}`);
      assert.equal(modelCalls,0);assert.equal(ctx.output.outcome.status,"failed");
      const pending=(await ctx.runtime.events.recoveryPending())[0];assert.ok(pending);
      await registry.dispatchSlashLine(ctx,"/resume reconcile");
      await registry.dispatchSlashLine(ctx,`/resume reconcile ${pending.id} completed checked the artifact and confirmed the effect`);
      assert.equal((await ctx.runtime.events.recoveryPending()).length,0);
      await ctx.runTurn("continue","continue");assert.equal(modelCalls,1);
    } finally {await ctx?.shutdown("complete");await rm(root,{recursive:true,force:true});}
  });
});

describe("R1: target binding remains stable while workers run", () => {
  it("waits for a worker's target lease before mutating the shared backend", async () => {
    const root=await mkdtemp(join(tmpdir(),"omr-target-lease-")); let ctx; let release;
    const gate=new Promise(r=>{release=r;}); let started;
    const running=new Promise(r=>{started=r;});
    try {
      ctx=await makeContext(root); ctx.currentTarget="/fixture/a"; await ctx.ensureConnected(); await ctx.ensureTargetOpen();
      ctx.modelController.buildActiveClient=()=>new FakeModel(async()=>{started();await gate;return {content:"old target finding"};});
      const worker=ctx.subagentRunner.spawnNode({goal:"inspect target a"}); await running;
      let mutationFinished=false;
      const mutation=ctx.rea.call("open_binary",{path:"/fixture/b"}).then(()=>{mutationFinished=true;});
      await delay(15);
      assert.equal(mutationFinished,false,"parent changed targets while the worker held the old binding");
      release(); await worker.promise; await mutation;
      assert.equal(ctx.runtime.binding.target,"/fixture/b");
    } finally {release();await ctx?.shutdown("complete");await rm(root,{recursive:true,force:true});}
  });
  it("rejects a queued worker whose pinned target changed before it acquired a lease", async () => {
    const root=await mkdtemp(join(tmpdir(),"omr-target-epoch-")); let ctx; let release;
    const gate=new Promise(r=>{release=r;}); let calls=0;
    try {
      ctx=await makeContext(root); ctx.currentTarget="/fixture/a"; await ctx.ensureConnected(); await ctx.ensureTargetOpen();
      ctx.modelController.buildActiveClient=()=>new FakeModel(async()=>{calls++; await gate; return {content:"finding"};});
      const roots=Array.from({length:4},()=>ctx.subagentRunner.spawnNode({goal:"inspect a"}));
      for (let i=0;i<100 && calls<4;i++) await delay(1);
      assert.equal(calls,4);
      const mutation=ctx.rea.call("open_binary",{path:"/fixture/b"});
      const queued=ctx.subagentRunner.spawnNode({goal:"queued for a"});
      release(); await Promise.all(roots.map(r=>r.promise)); await mutation;
      const result=await queued.promise;
      assert.equal(result.status,"failed");
      assert.match(queued.node.error,/binding changed/);
      assert.equal(calls,4);
    } finally {release();await ctx?.shutdown("complete");await rm(root,{recursive:true,force:true});}
  });
});

describe("B06: runtime budget survives parent/child work, fork and resume",()=>{
  it("shares usage across workers and preserves an independent branch baseline",async()=>{
    const root=await mkdtemp(join(tmpdir(),"omr-budget-runtime-"));let ctx;
    try{
      ctx=await makeContext(root);
      const raw=new FakeModel(()=>({content:"finding",usage:{prompt_tokens:40,completion_tokens:10,total_tokens:50}}));
      ctx.modelController.buildActiveClient=()=>raw;
      await createDefaultCommandRegistry().dispatchSlashLine(ctx,"/budget 50000");
      await ctx.runTurn("first","first");assert.equal(ctx.agent.totalTokens,50);
      const child=await ctx.subagentRunner.runTask({goal:"child"});assert.equal(child.totalTokens,50);assert.equal(ctx.agent.totalTokens,100);
      const source=ctx.session;
      await createDefaultCommandRegistry().dispatchSlashLine(ctx,"/fork budget-branch");
      await ctx.runTurn("second","second");assert.equal(ctx.agent.totalTokens,150);
      assert.equal(JSON.parse(await readFile(join(source.dir,"usage.json"),"utf8")).totalTokens,100);
      await createDefaultCommandRegistry().dispatchSlashLine(ctx,"/budget 60000");
      await createDefaultCommandRegistry().dispatchSlashLine(ctx,`/resume ${source.id}`);
      assert.equal(ctx.agent.totalTokens,100);assert.equal(ctx.runtime.usage.snapshot().priorUsageUnknown,false);assert.equal(ctx.runtime.usage.snapshot().budgetTokens,50000);
    }finally{await ctx?.shutdown("complete");await rm(root,{recursive:true,force:true});}
  });
});
