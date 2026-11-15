import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { ModelClient } from "../dist/model.js";
import { Agent } from "../dist/agent.js";

const native = {object: "response.compaction", output: [
  {type:"message",role:"user",content:[{type:"input_text",text:"ORIGINAL USER TRANSCRIPT, NOT A SUMMARY"}]},
  {id:"cmp_fixture",type:"compaction",encrypted_content:"opaque-native-fixture"},
], usage:{input_tokens:139,output_tokens:438,total_tokens:577}};

describe("B16: native and text compaction are different contracts", () => {
  it("rejects native opaque state as text and preserves custom text-summary support", async () => {
    let response = native;
    let hits = 0;
    const server = createServer(async (req,res)=>{
      hits++;
      for await (const _ of req) {}
      res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify(response));
    });
    await new Promise(r=>server.listen(0,"127.0.0.1",r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const model = new ModelClient({baseUrl,model:"fixture",providerId:"custom",apiKey:"fixture",maxTokens:200,timeoutMs:1000});
    try {
      await assert.rejects(model.compactRemote("system","transcript",200,undefined,`${baseUrl}/summary`), /native|opaque|Responses/i);
      await assert.rejects(model.compactRemote("system","transcript",200), /native|Responses/i);
      assert.equal(hits, 1, "unsupported native transport must be rejected before a billable request");
      response = {summary:"verified custom summary"};
      assert.equal(await model.compactRemote("system","transcript",200,undefined,`${baseUrl}/summary`), "verified custom summary");
      response = {output:[{type:"message",role:"user",content:[{type:"input_text",text:"echoed request"}]}]};
      await assert.rejects(model.compactRemote("system","transcript",200,undefined,`${baseUrl}/summary`), /summary/i);
    } finally {server.closeAllConnections(); await new Promise(r=>server.close(r));}
  });

  it("falls back to an actual summary without replacing history with echoed native input", async () => {
    let summaries = 0;
    const model = new ModelClient({baseUrl:"http://127.0.0.1:1",model:"fixture",providerId:"custom",apiKey:"fixture",maxTokens:200,timeoutMs:1000});
    model.summarize = async (_system, prompt) => { summaries++; assert.match(prompt,/original finding/); return "preserved evidence summary"; };
    const agent = new Agent(model, {definitions:()=>[],dispatch:async()=>{throw new Error("unused");}}, {systemPrompt:"system",compaction:()=>({strategy:"remote",contextWindow:1000,threshold:0.8,keepRecentTokens:10,remoteEndpoint:null})});
    agent.history.push({role:"user",content:"original finding"},{role:"assistant",content:"evidence ".repeat(1000)},{role:"user",content:"continue"});
    const report = await agent.compactWith("remote", "");
    assert.equal(report.strategy,"soft");
    assert.equal(summaries,1);
    assert.match(report.note,/native|Responses/i);
    assert.match(agent.history[1].content,/preserved evidence summary/);
  });
});
