import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent } from "../dist/agent.js";
import { ModelClient, FailoverModelClient } from "../dist/model.js";
import { DEFAULT_COMPACTION_SETTINGS, resolveThresholdTokens } from "../dist/compaction.js";
import { ContextOverflowError, parseCapabilityMetadata, resolveModelCapabilities, estimateImageTokens } from "../dist/capabilities.js";

const capabilities=(window)=>({contextWindow:window,maxOutputTokens:1024,vision:true,tools:true,nativeCompaction:false,source:"operator"});
const result={content:"done",reasoning:"",toolCalls:[],finishReason:"stop",usage:null};
const broker={definitions:()=>[],dispatch:async()=>{throw new Error("unused");}};

describe("B04: model capabilities drive context admission",()=>{
  it("uses verified exact identities, live metadata and a conservative unknown fallback",()=>{
    assert.equal(resolveModelCapabilities("gpt-4.1","openai").contextWindow,1_047_576);
    assert.equal(resolveModelCapabilities("gpt-4.1","custom").contextWindow,32_768);
    const metadata=parseCapabilityMetadata({context_length:8192,top_provider:{max_completion_tokens:1024},capabilities:{vision:false,tools:true}});
    const resolved=resolveModelCapabilities("gpt-4.1","openai",metadata);
    assert.equal(resolved.contextWindow,8192);assert.equal(resolved.vision,false);assert.equal(resolved.source,"provider-metadata");
    assert.equal(resolved.maxOutputTokens,1024);
    const model=new ModelClient({model:"gpt-4o-mini",providerId:"openai",maxTokens:32000});
    assert.equal(model.outputReserveTokens,16384);
  });

  it("counts attached images even without image_tokens and never trusts an underestimate",()=>{
    const image={mimeType:"image/png",data:"cGl4ZWxz"};
    assert.ok(estimateImageTokens(image)>0);
    const agent=new Agent({model:"unknown",stream:async()=>result},broker,{systemPrompt:"system"});
    const before=agent.contextUsage().tokens;
    agent.history.push({role:"user",content:"inspect",images:[image],image_tokens:1});
    assert.ok(agent.contextUsage().tokens-before>=4096);
    assert.equal(agent.contextUsage().window,32768);
  });

  it("reserves output and honors an explicit operator window",()=>{
    const model={model:"fixture",capabilities:capabilities(8192),outputReserveTokens:2048,stream:async()=>result};
    const automatic=new Agent(model,broker,{systemPrompt:"system"});
    assert.equal(automatic.contextUsage().window,8192);
    assert.ok(automatic.contextUsage().thresholdTokens<=6144);
    const explicit=new Agent(model,broker,{systemPrompt:"system",compaction:()=>({...DEFAULT_COMPACTION_SETTINGS,contextWindow:65536,windowSource:"operator"})});
    assert.equal(explicit.contextUsage().window,65536);
    assert.equal(resolveThresholdTokens({...DEFAULT_COMPACTION_SETTINGS,contextWindow:10000,thresholdPercent:99,outputReserveTokens:3000}),7000);
  });

  it("counts tool schemas and refuses a request that cannot fit the active window",async()=>{
    let calls=0;
    const model={model:"fixture",capabilities:capabilities(4096),outputReserveTokens:256,stream:async()=>{calls++;return result;}};
    const agent=new Agent(model,{...broker,definitions:()=>[{type:"function",function:{name:"huge",description:"schema ".repeat(3000),parameters:{type:"object"}}}]},{systemPrompt:"system"});
    const turn=await agent.run("inspect");assert.equal(turn.status,"partial");assert.equal(turn.finishReason,"context_window");assert.equal(calls,0);
  });

  it("recovers once from a provider overflow with a smaller valid projection",async()=>{
    let calls=0;
    const model={model:"fixture",capabilities:capabilities(8000),outputReserveTokens:256,stream:async()=>{if(++calls===1) throw new ContextOverflowError("actual context window is 4000",4000);return result;}};
    const agent=new Agent(model,broker,{systemPrompt:"system"});
    agent.history.push({role:"user",content:"old"},{role:"assistant",content:null,tool_calls:[{id:"call",type:"function",function:{name:"read",arguments:"{}"}}]},{role:"tool",tool_call_id:"call",content:"x".repeat(12000)},{role:"assistant",content:"old done"});
    const turn=await agent.run("continue");assert.equal(turn.status,"completed");assert.equal(calls,2);assert.equal(agent.contextUsage().window,4000);
  });

  it("skips fallback requests that exceed the candidate model's context",async()=>{
    let fallbackCalls=0;
    const primary={model:"large",capabilities:capabilities(100000),outputReserveTokens:256,stream:async()=>{throw new Error("unavailable");}};
    const fallback={model:"small",capabilities:capabilities(4000),outputReserveTokens:256,stream:async()=>{fallbackCalls++;return result;}};
    const chain=new FailoverModelClient([{spec:"large",client:primary},{spec:"small",client:fallback}]);
    await assert.rejects(chain.stream([{role:"user",content:"x".repeat(16000)}],[],undefined,()=>{}),ContextOverflowError);
    assert.equal(fallbackCalls,0);
  });
});
