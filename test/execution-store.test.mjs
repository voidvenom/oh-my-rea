import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Agent } from "../dist/agent.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../dist/compaction.js";
import { ExecutionStore, UncertainInvocationError, argumentDigest, readExecutionEvents } from "../dist/execution.js";

const scratch = async fn => {const root=await mkdtemp(join(tmpdir(),"omr-execution-"));try {await fn(root);} finally {await rm(root,{recursive:true,force:true});}};
const intent = {backend:"script",tool:"effect",args:{x:1},readOnly:false,binding:{target:"fixture"}};
const eventsAt = async path => {const result=[];for await (const event of readExecutionEvents(path)) result.push(event);return result;};

describe("R2: durable intent, crash recovery, and canonical conversation", () => {
  it("publishes and syncs intent before the side effect and records its exact result", async () => {
    await scratch(async root=>{
      const store=new ExecutionStore("fixture",root);
      const result=await store.invoke(intent,async()=>{
        const events=await eventsAt(store.path);
        assert.equal(events.at(-1).type,"invocation.started");
        assert.equal(events.at(-1).data.argsDigest,argumentDigest({x:1}));
        return {value:42};
      });
      assert.deepEqual(result,{value:42});
      assert.equal((await store.unresolved()).length,0);
      assert.deepEqual((await eventsAt(store.path)).at(-1).data.result,{value:42});
    });
  });

  it("detects a real child crash after a side effect and blocks repeating it", async () => {
    await scratch(async root=>{
      const effect=join(root,"effect.txt");
      const crashed=spawnSync(process.execPath,[fileURLToPath(new URL("./fixtures/execution-crash.mjs",import.meta.url)),root,effect],{encoding:"utf8"});
      assert.equal(crashed.status,17,crashed.stderr);
      assert.equal(await readFile(effect,"utf8"),"one completed side effect");
      const store=new ExecutionStore("reopened",root);
      const pending=await store.unresolved(); assert.equal(pending.length,1);
      let repeats=0;
      await assert.rejects(store.invoke({...intent,args:{file:effect}},async()=>{repeats++;}),UncertainInvocationError);
      assert.equal(repeats,0);
      await store.resolve(pending[0].id,"completed","effect file confirms the operation completed");
      assert.equal((await new ExecutionStore("third-open",root).unresolved()).length,0);
      assert.match(store.recoveryNote(),/do not repeat/);
    });
  });

  it("never dispatches when the write-ahead log cannot be created", async () => {
    await scratch(async root=>{
      await mkdir(join(root,"execution.jsonl"));
      let effects=0;
      await assert.rejects(new ExecutionStore("fixture",root).invoke(intent,async()=>{effects++;}));
      assert.equal(effects,0);
    });
  });

  it("keeps a live background operation distinct from a recovered uncertain operation", async () => {
    await scratch(async root=>{
      const store=new ExecutionStore("fixture",root);let release,started;
      const gate=new Promise(r=>{release=r;});const active=new Promise(r=>{started=r;});
      const work=store.invoke(intent,async()=>{started();await gate;return "done";});
      await active;
      const pending=(await store.unresolved())[0];
      assert.ok(pending);assert.equal((await store.recoveryPending()).length,0);
      await assert.rejects(store.resolve(pending.id,"retry","too early"),/still running/);
      release();await work;
    });
  });

  it("serializes concurrent records and preserves an uncommitted tail during repair", async () => {
    await scratch(async root=>{
      const store=new ExecutionStore("fixture",root);
      await Promise.all(Array.from({length:20},(_,i)=>store.append("fixture",{i})));
      const partial='{"schema":1,"seq":21,"type":"incomplete"';
      await appendFile(store.path,partial);
      const reopened=new ExecutionStore("reopened",root);
      await reopened.append("recovered",{});
      const events=await eventsAt(store.path);
      assert.deepEqual(events.map(e=>e.seq),Array.from({length:21},(_,i)=>i+1));
      const archive=(await readdir(root)).find(name=>name.startsWith("execution.jsonl.partial-"));
      assert.ok(archive);assert.equal(await readFile(join(root,archive),"utf8"),partial);
    });
  });

  it("retains original messages after repeated compaction rewrites the model projection", async () => {
    await scratch(async root=>{
      const store=new ExecutionStore("fixture",root);
      const agent=new Agent({model:"fixture"},{definitions:()=>[],dispatch:async()=>{throw new Error("unused");}},{systemPrompt:"system",compaction:()=>({...DEFAULT_COMPACTION_SETTINGS,strategy:"snapcompact",keepRecentTokens:20}),historyCheckpoint:(messages,reason)=>store.captureConversation("primary",messages,reason)});
      agent.history.push({role:"user",content:"ORIGINAL_SECRET"},{role:"assistant",content:"finding ".repeat(2000)},{role:"user",content:"tail"});
      await agent.compactWith("snapcompact","");
      agent.history.push({role:"assistant",content:"newer finding ".repeat(2000)},{role:"user",content:"second tail"});
      await agent.compactWith("snapcompact","");
      const events=await eventsAt(store.path);
      assert.ok(events.some(e=>e.type==="projection.reset"));
      assert.ok(events.some(e=>e.type==="conversation.append"&&e.data.messages.some(m=>m.content==="ORIGINAL_SECRET")));
      assert.match(await readFile(store.path,"utf8"),/ORIGINAL_SECRET/);
    });
  });

  it("shows native journal candidates without treating a digest match as ownership proof", async () => {
    await scratch(async root=>{
      const store=new ExecutionStore("fixture",root);
      await assert.rejects(store.invoke(intent,async()=>{throw new Error("lost response");}),UncertainInvocationError);
      const pending=(await store.unresolved())[0];
      const journal=join(root,"journal.jsonl");
      await writeFile(journal,[{type:"tool.call",call_id:"native-1",tool:"effect",args_digest:argumentDigest({x:1})},{type:"tool.result",call_id:"native-1",tool:"effect",ok:true,evidence_ids:[]}].map(r=>JSON.stringify(r)).join("\n")+"\n");
      const candidates=await store.reconcileNativeJournal(journal);
      assert.equal(candidates[0].candidates[0].call_id,"native-1");
      assert.equal((await store.unresolved()).length,1);
      await store.resolve(pending.id,"retry","operator checked the target and explicitly approved retry");
      let effects=0;await store.invoke(intent,async()=>{effects++;});assert.equal(effects,1);
    });
  });
});
