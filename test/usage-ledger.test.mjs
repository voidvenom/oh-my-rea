import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Agent } from "../dist/agent.js";
import { ModelClient, FailoverModelClient } from "../dist/model.js";
import { UsageLedger, BudgetModelClient, BudgetExceededError } from "../dist/usage.js";

const scratch=async fn=>{const root=await mkdtemp(join(tmpdir(),"omr-usage-"));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}};
const usage={prompt_tokens:20,completion_tokens:5,total_tokens:25};
const response={content:"ok",reasoning:"",toolCalls:[],finishReason:"stop",usage};
const caps={contextWindow:4096,maxOutputTokens:100,vision:true,tools:true,nativeCompaction:false,source:"operator"};
const raw={model:"fixture",capabilities:caps,outputReserveTokens:100,stream:async()=>response,summarize:async()=>"summary"};
const stream=client=>client.stream([{role:"user",content:"hi"}],[],undefined,()=>{});
const clientAt=port=>new ModelClient({providerId:"custom",protocol:"openai-chat",baseUrl:`http://127.0.0.1:${port}`,model:"fixture",apiKey:"fixture",apiKeyEnv:"TEST",maxTokens:100,temperature:null,maxSteps:1,timeoutMs:1000,capabilities:{contextWindow:4096,maxOutputTokens:100}});
const sse=res=>{res.writeHead(200,{"content-type":"text/event-stream"});res.end(`data: ${JSON.stringify({choices:[{delta:{content:"ok"},finish_reason:"stop"}],usage})}\n\ndata: [DONE]\n\n`);};

describe("B06: shared durable token budget",()=>{
  it("reserves concurrent capacity atomically and restores spent usage without a reset",async()=>{
    await scratch(async root=>{
      const ledger=new UsageLedger(root);ledger.setLimitProvider(()=>200);
      const leases=await Promise.all([ledger.reserve("primary","fixture",40,100),ledger.reserve("child","fixture",40,100)]);
      assert.equal(ledger.snapshot().reservedTokens,200);
      assert.deepEqual(leases.map(l=>l.maxOutputTokens).sort((a,b)=>a-b),[20,100]);
      await assert.rejects(ledger.reserve("other","fixture",1,1),BudgetExceededError);
      await ledger.settle(leases[0].id,{prompt_tokens:40,completion_tokens:60,total_tokens:100});
      await ledger.settle(leases[1].id,{prompt_tokens:20,completion_tokens:10,total_tokens:30});
      const restored=new UsageLedger(root);await restored.initialize();assert.equal(restored.snapshot().totalTokens,130);assert.equal(restored.snapshot().budgetTokens,200);
      const model=new BudgetModelClient(raw,restored,"primary");
      const agent=new Agent(model,{definitions:()=>[],dispatch:async()=>{throw new Error("unused");}},{systemPrompt:"system"});
      agent.restoreHistory([{role:"user",content:"restored"}]);assert.equal(agent.totalTokens,130);agent.clear();assert.equal(agent.totalTokens,130);
    });
  });

  it("charges primary, child and summary work to one ledger and labels estimates",async()=>{
    await scratch(async root=>{
      const ledger=new UsageLedger(root);ledger.setLimitProvider(()=>1000);
      await stream(new BudgetModelClient(raw,ledger,"primary"));
      await stream(new BudgetModelClient(raw,ledger,"child"));
      await new BudgetModelClient(raw,ledger,"compaction").summarize("system","transcript",20);
      const snapshot=ledger.snapshot();assert.ok(snapshot.totalTokens>50);assert.ok(snapshot.estimatedTokens>0);
      assert.equal(snapshot.totalTokens,ledger.snapshot("primary").scopeTokens+ledger.snapshot("child").scopeTokens+ledger.snapshot("compaction").scopeTokens);
      assert.equal(snapshot.reservedTokens,0);
    });
  });

  it("accounts an interrupted model reservation once after a real process exit",async()=>{
    await scratch(async root=>{
      const processResult=spawnSync(process.execPath,[fileURLToPath(new URL("./fixtures/usage-crash.mjs",import.meta.url)),root],{encoding:"utf8"});assert.equal(processResult.status,17,processResult.stderr);
      const recovered=new UsageLedger(root);recovered.setLimitProvider(()=>150);await recovered.initialize();
      assert.equal(recovered.snapshot().totalTokens,150);assert.equal(recovered.snapshot().estimatedTokens,150);
      await assert.rejects(recovered.reserve("child","fixture",1,1),BudgetExceededError);
      const again=new UsageLedger(root);await again.initialize();assert.equal(again.snapshot().totalTokens,150);
    });
  });

  it("requires an explicit baseline for legacy untracked history",async()=>{
    await scratch(async root=>{
      await writeFile(join(root,"history.json"),JSON.stringify({messages:[{role:"user",content:"prior work"}]}));
      const ledger=new UsageLedger(root);ledger.setLimitProvider(()=>200);await ledger.initialize();assert.equal(ledger.snapshot().priorUsageUnknown,true);
      await assert.rejects(ledger.reserve("primary","fixture",10,20),BudgetExceededError);
      await ledger.reset("operator explicitly starts a new measured budget");
      const lease=await ledger.reserve("primary","fixture",10,20);assert.ok(lease);
      await ledger.settle(lease.id,null);assert.equal(ledger.snapshot().totalTokens,30);
    });
  });

  it("charges a real summarizer response using provider usage",async()=>{
    await scratch(async root=>{
      const server=createServer(async(req,res)=>{for await(const _ of req){}sse(res);});await new Promise(r=>server.listen(0,"127.0.0.1",r));
      try{
        const ledger=new UsageLedger(root);ledger.setLimitProvider(()=>1000);
        const summary=await new BudgetModelClient(clientAt(server.address().port),ledger,"compaction").summarize("system","summarize this",100);
        assert.equal(summary,"ok");assert.equal(ledger.snapshot("compaction").scopeTokens,25);assert.equal(ledger.snapshot().estimatedTokens,0);
      }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
    });
  });

  it("applies a smaller durable output limit to an actual HTTP retry",async()=>{
    await scratch(async root=>{
      const requests=[];
      const server=createServer(async(req,res)=>{let text="";for await(const part of req)text+=part;requests.push(JSON.parse(text));if(requests.length===1){res.writeHead(503,{"retry-after":"0"});res.end('{"error":"retry fixture"}');}else sse(res);});
      await new Promise(r=>server.listen(0,"127.0.0.1",r));
      try{
        const ledger=new UsageLedger(root);ledger.setLimitProvider(()=>200);
        await stream(new BudgetModelClient(clientAt(server.address().port),ledger,"primary"));
        assert.equal(requests.length,2);assert.ok(requests[1].max_tokens<requests[0].max_tokens);
        assert.ok(ledger.snapshot().estimatedTokens>0);assert.ok(ledger.snapshot().totalTokens<=200);assert.equal(ledger.snapshot().reservations,0);
      }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
    });
  });

  it("stops a retry before dispatch when its first uncertain attempt consumed the cap",async()=>{
    await scratch(async root=>{
      let requests=0;const server=createServer(async(req,res)=>{for await(const _ of req){}requests++;res.writeHead(503,{"retry-after":"0"});res.end('{"error":"retry fixture"}');});
      await new Promise(r=>server.listen(0,"127.0.0.1",r));
      try{
        const ledger=new UsageLedger(root);ledger.setLimitProvider(()=>100);
        await assert.rejects(stream(new BudgetModelClient(clientAt(server.address().port),ledger,"primary")),BudgetExceededError);
        assert.equal(requests,1);assert.equal(ledger.snapshot().totalTokens,100);
      }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
    });
  });

  it("accounts failed primary and successful fallback separately",async()=>{
    await scratch(async root=>{
      let attempts=0;const primary={...raw,model:"primary",stream:async()=>{attempts++;throw new Error("lost primary response");}};
      const fallback={...raw,model:"fallback",stream:async()=>{attempts++;return response;}};
      const ledger=new UsageLedger(root);ledger.setLimitProvider(()=>300);
      const chain=new FailoverModelClient([{spec:"primary",client:primary},{spec:"fallback",client:fallback}]);
      await stream(new BudgetModelClient(chain,ledger,"primary"));
      assert.equal(attempts,2);assert.ok(ledger.snapshot().totalTokens>25);assert.ok(ledger.snapshot().estimatedTokens>0);
    });
  });

  it("keeps concurrent request limits scoped to each call on a reused ModelClient",async()=>{
    await scratch(async root=>{
      const requests=[],responses=[];let both;const received=new Promise(r=>{both=r;});
      const server=createServer(async(req,res)=>{let text="";for await(const part of req)text+=part;requests.push(JSON.parse(text));responses.push(res);if(requests.length===2)both();});
      await new Promise(r=>server.listen(0,"127.0.0.1",r));
      try{
        const ledger=new UsageLedger(root);ledger.setLimitProvider(()=>200);const model=clientAt(server.address().port);
        const pending=Promise.all([stream(new BudgetModelClient(model,ledger,"primary")),stream(new BudgetModelClient(model,ledger,"child"))]);
        await received;assert.equal(ledger.snapshot().reservedTokens,200);assert.notEqual(requests[0].max_tokens,requests[1].max_tokens);
        for(const res of responses)sse(res);await pending;
        assert.equal(model.outputReserveTokens,100);assert.equal(ledger.snapshot().totalTokens,50);
      }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
    });
  });
});
