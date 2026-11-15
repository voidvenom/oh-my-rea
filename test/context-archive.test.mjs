import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Agent } from "../dist/agent.js";
import { ContextArchive, contextArchiveTool } from "../dist/contextArchive.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../dist/compaction.js";
import { estimateRequestTokens } from "../dist/capabilities.js";
import { createSession, forkSession } from "../dist/session.js";
import { TaskStateStore } from "../dist/taskState.js";

describe("bounded context projection and durable archive retrieval",()=>{
  it("keeps twelve compactions within a 32k projection and retrieves the original text and frames",async()=>{
    const root=await mkdtemp(join(tmpdir(),"omr-context-archive-"));const archive=new ContextArchive(root,"source");
    try{
      const agent=new Agent({model:"fixture"},{definitions:()=>[],dispatch:async()=>{throw Error("unused");}},{systemPrompt:"fixture",archiveProjection:input=>archive.project(input),compaction:()=>({...DEFAULT_COMPACTION_SETTINGS,strategy:"snapcompact",keepRecentTokens:20,contextWindow:32768,contextWindowExplicit:true})});
      for(let round=0;round<12;round++){agent.history.push({role:"user",content:`original-marker-${round}`},{role:"assistant",content:`round ${round}: ${"retained unique observation ".repeat(1000)}`},{role:"user",content:`tail ${round}`});await agent.compactWith("snapcompact","");assert.ok(estimateRequestTokens(agent.history)<32768);assert.ok(agent.history.flatMap(message=>message.images??[]).length<=1);}
      const {value:list}=await archive.read({action:"list",limit:100});assert.ok(list.entries.length>=24);
      let found=false;for(const entry of list.entries.filter(entry=>entry.kind==="text")){const {value}=await archive.read({action:"get",ref:entry.id,limit:20000});if(value.text.includes("original-marker-0"))found=true;}assert.equal(found,true);
      const image=list.entries.find(entry=>entry.kind==="image");const result=await contextArchiveTool(archive).invoke({action:"get",ref:image.id});assert.equal(result.images.length,1);assert.equal(Buffer.from(result.images[0].data,"base64").length,image.bytes);assert.deepEqual(result.evidenceIds,[]);
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it("copies archive refs with their origin on fork and refuses modified archived bytes",async()=>{
    const root=await mkdtemp(join(tmpdir(),"omr-context-fork-"));
    try{const source=await createSession(null,null,{rootDir:root});const archive=new ContextArchive(source.dir,source.id);await archive.project({messages:[{role:"user",content:"complete original"}],images:[],imageTokens:0,summary:"summary",activeImageBudget:100});const fork=await forkSession(source,[],null,"fixture",{rootDir:root});await rm(source.dir,{recursive:true,force:true});const copied=new ContextArchive(fork.dir,fork.id);const list=(await copied.read({action:"list"})).value;const entry=list.entries[0];assert.equal(entry.originSessionId,source.id);assert.match((await copied.read({action:"get",ref:entry.id})).value.text,/complete original/);await writeFile(join(copied.directory,entry.id),"x".repeat(entry.bytes));await assert.rejects(copied.read({action:"get",ref:entry.id}),/digest mismatch/);await assert.rejects(copied.read({action:"get",ref:"../../outside"}),/requires a ctx_/);}
    finally{await rm(root,{recursive:true,force:true});}
  });
  it("keeps full goals durable while previewing acceptance and constraints and invalidates its revision cache",async()=>{
    const root=await mkdtemp(join(tmpdir(),"omr-note-cache-"));try{const task=new TaskStateStore(root);const goal="g".repeat(300000);await task.initializeGoal(goal);await task.update({constraints:["retain outputs"],acceptance:[{id:"proof",text:"visible acceptance"}]},1);const first=task.contextNote();assert.match(first,/retain outputs/);assert.match(first,/visible acceptance/);assert.ok(first.length<8500);assert.equal((await task.read()).goal,goal);await task.update({constraints:["new constraint"]},2);assert.match(task.contextNote(),/new constraint/);assert.doesNotMatch(task.contextNote(),/retain outputs/);assert.equal(JSON.parse(await readFile(task.path,"utf8")).goal,goal);}
    finally{await rm(root,{recursive:true,force:true});}
  });
});
