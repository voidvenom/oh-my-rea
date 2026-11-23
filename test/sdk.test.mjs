import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createRuntime } from "oh-my-rea/sdk";
import { FakeModel, FakeRea } from "../dist/testing/fakes.js";
const env=root=>({PATH:process.env.PATH,XDG_CONFIG_HOME:root,OMR_MODEL:"gpt-4.1",OPENAI_API_KEY:"fixture"});
describe("public SDK consumer contract",()=>{
  it("resolves the installed-style SDK subpath and TypeScript declarations",()=>{
    const compiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
    const consumer = fileURLToPath(new URL("fixtures/sdk-consumer.mts", import.meta.url));
    const check=spawnSync(process.execPath,[compiler,"--noEmit","--module","NodeNext","--moduleResolution","NodeNext","--target","ES2024","--strict","--skipLibCheck",consumer],{encoding:"utf8"});assert.equal(check.status,0,check.stdout+check.stderr);
  });
  it("runs offline typed commands, serializes updates, and reads durable event cursors without starting backends",async()=>{
    const root=await mkdtemp(join(tmpdir(),"omr-sdk-offline-"));let runtime,connections=0;const live=[];
    try{runtime=await createRuntime({cwd:root,sessionsRootDir:root,env:env(root),noModel:true,onEvent:event=>live.push(event),adapters:{connectRea:async()=>{connections++;throw Error("must remain offline");}}});const [first,second]=await Promise.all([runtime.command('/state update 0 {"goal":"keep original"}'),runtime.command('/state update 1 {"constraints":["retain evidence"]}')]);assert.equal(first.outcome.status,"completed");assert.equal(second.exitCode,0);assert.equal((await runtime.snapshot()).task.revision,2);assert.equal(connections,0);assert.equal(live.filter(event=>event.event.type==="task.updated").length,2);const page=await runtime.readEvents({limit:1});assert.equal(page.length,1);const next=await runtime.readEvents({afterSeq:page[0].seq});assert.ok(next.every(event=>event.seq>page[0].seq));await runtime.close();await runtime.close();await assert.rejects(runtime.command("/state get"),/closed/);assert.equal((await runtime.snapshot()).task.goal,"keep original");}
    finally{await runtime?.close();await rm(root,{recursive:true,force:true});}
  });
  it("uses the actual runtime for model work, follows fork/resume events, and isolates listener failures",async()=>{
    const root=await mkdtemp(join(tmpdir(),"omr-sdk-model-"));let runtime;const observations=[];const models=[];
    try{runtime=await createRuntime({cwd:root,sessionsRootDir:root,env:env(root),onEvent:event=>observations.push(event),adapters:{connectRea:async dir=>new FakeRea(dir),createModelClient:()=>{const model=new FakeModel([{content:"first answer"},{content:"continued answer"},{content:"third answer"}]);models.push(model);return model;}}});runtime.onEvent(async()=>{throw Error("controlled listener failure");});const result=await runtime.run("complete original goal");assert.equal(result.outcome.status,"completed");assert.equal(result.text,"first answer");const source=result.session.id;assert.equal((await runtime.command("/fork fixture")).exitCode,0);const fork=(await runtime.snapshot()).session.id;assert.notEqual(fork,source);assert.equal((await runtime.run("continue")).exitCode,0);assert.ok(observations.some(event=>event.event.sessionId===fork&&event.event.type==="model.request"));assert.ok(runtime.observerErrors().some(error=>error.includes("controlled listener")));const resumed=await runtime.command(`/resume ${source}`);assert.equal(resumed.exitCode,0);assert.notEqual(resumed.session.id,source);assert.equal((await runtime.snapshot()).task.goal,"complete original goal");assert.ok(observations.some(event=>event.replayed));assert.ok(models.length>=1);}
    finally{await runtime?.close();await rm(root,{recursive:true,force:true});}
  });
  it("cancels startup and queued turns and closes without process signal handlers or process.exit",{timeout:5000},async()=>{
    const root=await mkdtemp(join(tmpdir(),"omr-sdk-abort-"));let runtime;let started;const connected=new Promise(resolve=>{started=resolve;});const sigterm=process.listenerCount("SIGTERM");
    try{runtime=await createRuntime({cwd:root,sessionsRootDir:root,env:env(root),adapters:{createModelClient:()=>new FakeModel([{content:"unused"}]),connectRea:async(_dir,_env,_sources,options)=>{started();await delay(30000,undefined,{signal:options.signal});throw Error("unreachable");}}});const running=runtime.run("start");await Promise.race([connected,running.then(result=>{throw new Error(`Startup never reached adapter: ${JSON.stringify(result)}`);})]);const queued=runtime.run("queued",{signal:AbortSignal.abort()});runtime.cancel();assert.equal((await running).outcome.status,"cancelled");assert.equal((await queued).outcome.status,"cancelled");await runtime.close();assert.equal(process.listenerCount("SIGTERM"),sigterm);}
    finally{await runtime?.close();await rm(root,{recursive:true,force:true});}
  });
});
