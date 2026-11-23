import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { ResourceScheduler, resources, configureResourceLimits, DEFAULT_RESOURCE_LIMITS } from "../dist/resources.js";
import { BudgetModelClient, UsageLedger } from "../dist/usage.js";
import { Rea } from "../dist/rea.js";
import { BrowserManager } from "../dist/browser.js";
import { runSessionScript } from "../dist/exec.js";
import { sessionLauncher } from "../dist/ownedProcess.js";
import { runBangCommand } from "../dist/bang.js";
const fixture=fileURLToPath(new URL("./fixtures/mcp-server.mjs",import.meta.url));
const until=async fn=>{for(let i=0;i<300;i++){if(await fn())return;await delay(10);}throw new Error("Fixture deadline");};

describe("process-global physical backend admission",()=>{
  it("transfers FIFO leases once, bounds queues, and removes aborted waiters",async()=>{
    const scheduler=new ResourceScheduler({model:1},2), order=[]; const first=await scheduler.acquire("model");
    const controller=new AbortController(); const aborted=scheduler.acquire("model",controller.signal); const second=scheduler.run("model",async()=>{order.push(2);throw new Error("controlled");});
    await assert.rejects(scheduler.acquire("model"),/queue is full/); assert.throws(()=>scheduler.configure({model:2}),/while leases/);
    controller.abort();await assert.rejects(aborted);first();first();await assert.rejects(second,/controlled/);
    await scheduler.run("model",async()=>order.push(3));assert.deepEqual(order,[2,3]);assert.equal(scheduler.snapshot().model.active,0);assert.equal(scheduler.snapshot().model.peak,1);assert.equal(scheduler.snapshot().model.cancelled,1);
    assert.throws(()=>scheduler.configure({model:0}),/Invalid resource/);assert.equal(scheduler.snapshot().model.limit,1);
  });
  it("shares model capacity across parent, child, summary and independent session ledgers",async()=>{
    const root=await mkdtemp(join(tmpdir(),"omr-model-capacity-"));configureResourceLimits({model:1});let unblock;const blocked=new Promise(resolve=>{unblock=resolve;});let calls=0;
    const model={model:"fixture",outputReserveTokens:10,stream:async()=>{calls++;await blocked;return{content:"ok",toolCalls:[],finishReason:"stop",usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}};},summarize:async()=>{calls++;return"summary";}};
    await Promise.all([mkdir(join(root,"a")),mkdir(join(root,"b"))]);const ledgers=[new UsageLedger(join(root,"a")),new UsageLedger(join(root,"b"))];
    try{
      const parent=new BudgetModelClient(model,ledgers[0],"primary"),child=new BudgetModelClient(model,ledgers[1],"child");
      const a=parent.stream([{role:"user",content:"a"}],[],undefined,()=>{});await until(()=>calls===1);
      const abort=new AbortController();const b=child.stream([{role:"user",content:"b"}],[],abort.signal,()=>{});const c=child.summarize("system","user",10);
      await until(()=>resources.snapshot().model.queued===2);abort.abort();await assert.rejects(b);assert.equal(ledgers[1].snapshot().reservedTokens,0);unblock();await a;await c;
      assert.equal(calls,2);assert.equal(resources.snapshot().model.active,0);assert.equal(ledgers[0].snapshot().totalTokens,3);
    }finally{unblock();configureResourceLimits(DEFAULT_RESOURCE_LIMITS);await rm(root,{recursive:true,force:true});}
  });
  it("bounds persistent MCP processes, releases failed startup, and never dispatches a cancelled queue item",async()=>{
    const root=await mkdtemp(join(tmpdir(),"omr-rea-capacity-"));configureResourceLimits({mcpProcess:1,rea:1});const env={PATH:process.env.PATH,OMR_REA_COMMAND:fixture,OMR_FIXTURE_MODE:"normal",OMR_FIXTURE_TOOL_DELAY:"80"};let one,two;
    try{
      await assert.rejects(Rea.connect(join(root,"bad"),{...env,OMR_FIXTURE_MODE:"catalog-error"},[]),/controlled catalog/);assert.equal(resources.snapshot().mcpProcess.active,0);
      one=await Rea.connect(join(root,"one"),env,[]);const opening=Rea.connect(join(root,"two"),env,[]);await until(()=>resources.snapshot().mcpProcess.queued===1);
      const first=one.call("fixture_echo",{value:1});const abort=new AbortController();const queued=one.call("fixture_echo",{value:2},{signal:abort.signal});await until(()=>resources.snapshot().rea.queued===1);abort.abort();await assert.rejects(queued,/before dispatch/);await first;
      await one.close();two=await opening;assert.equal(resources.snapshot().mcpProcess.active,1);await two.close();assert.equal(resources.snapshot().mcpProcess.active,0);
    }finally{await one?.close();await two?.close();configureResourceLimits(DEFAULT_RESOURCE_LIMITS);await rm(root,{recursive:true,force:true});}
  });
  it("kills owned MCP descendants that ignore TERM before releasing process capacity",{skip:!sessionLauncher() && "requires Linux setsid and /proc process status"},async()=>{
    const root=await mkdtemp(join(tmpdir(),"omr-rea-descendant-"));let rea;
    const live=async pid=>{try{return!/^\S+ \(.+\) Z /.test(await readFile(`/proc/${pid}/stat`,"utf8"));}catch{return false;}};
    try{const pidFile=join(root,"child.pid");rea=await Rea.connect(root,{PATH:process.env.PATH,OMR_REA_COMMAND:fixture,OMR_FIXTURE_MODE:"normal-descendant",OMR_FIXTURE_DESC_PID_FILE:pidFile},[]);const pid=Number(await readFile(pidFile,"utf8"));await delay(50);assert.equal(await live(pid),true);await rea.close();await until(async()=>!await live(pid));assert.equal(resources.snapshot().mcpProcess.active,0);}
    finally{await rea?.close();await rm(root,{recursive:true,force:true});}
  });
  it("reaps background descendants after normal script and shell parent exit",{skip:process.platform!=="linux" && "requires Linux /proc process status and POSIX group ownership"},async()=>{
    const root=await mkdtemp(join(tmpdir(),"omr-run-descendant-"));
    const code="import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});writeFileSync(process.argv[2],String(c.pid));c.unref();";
    const alive=async pid=>{try{return!/^\S+ \(.+\) Z /.test(await readFile(`/proc/${pid}/stat`,"utf8"));}catch{return false;}};
    try{const script=join(root,"parent.mjs");await writeFile(script,code);for(const kind of["script","shell"]){const path=join(root,`${kind}.pid`);const result=kind==="script"?await runSessionScript({scriptsDir:root,script:"parent.mjs",args:[path],network:true}):await runBangCommand(`"${process.execPath}" "${script}" "${path}"`,{cwd:root});assert.equal(result.exitCode,0);const pid=Number(await readFile(path,"utf8"));await until(async()=>!await alive(pid));assert.equal(resources.snapshot()[kind].active,0);}}
    finally{await rm(root,{recursive:true,force:true});}
  });
  it("limits script subprocesses and browser requests across independent managers",async()=>{
    const root=await mkdtemp(join(tmpdir(),"omr-backend-capacity-"));configureResourceLimits({script:1,browser:1});let active=0,peak=0;const managers=[];
    const server=createServer(async(_req,res)=>{active++;peak=Math.max(peak,active);await delay(35);res.setHeader("content-type","application/json");res.end('{"tabs":[]}');active--;});await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    try{
      const args={scriptsDir:root,script:"fixture.mjs",code:"setTimeout(()=>console.log('done'),100)",network:true};const a=runSessionScript(args);await until(()=>resources.snapshot().script.active===1);const abort=new AbortController();const b=runSessionScript({...args,script:"cancelled.mjs",signal:abort.signal});await until(()=>resources.snapshot().script.queued===1);abort.abort();await assert.rejects(b);assert.equal((await a).ok,true);
      for(let i=0;i<2;i++){const manager=new BrowserManager(root,{CAMOFOX_BASE_URL:`http://127.0.0.1:${server.address().port}`,CAMOFOX_USER_ID:`fixture${i}`});manager.ensureCamofoxRunning=async()=>({reachable:true});managers.push(manager);}
      const results=await Promise.all(managers.flatMap(manager=>[manager.call("camofox_list_tabs",{}),manager.call("camofox_list_tabs",{})]));assert.ok(results.every(result=>!result.isError));assert.equal(peak,1);assert.equal(resources.snapshot().browser.active,0);
    }finally{await Promise.all(managers.map(manager=>manager.close()));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));configureResourceLimits(DEFAULT_RESOURCE_LIMITS);await rm(root,{recursive:true,force:true});}
  });
});
