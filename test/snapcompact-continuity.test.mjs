import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Agent } from "../dist/agent.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../dist/compaction.js";
import { createSession, saveSessionHistory, loadSavedSession } from "../dist/session.js";

const broker={definitions:()=>[],dispatch:async()=>{throw new Error("unused");}};
const makeAgent=()=>new Agent({model:"vision-fixture"},broker,{systemPrompt:"system",compaction:()=>({...DEFAULT_COMPACTION_SETTINGS,strategy:"snapcompact",keepRecentTokens:20})});
const hash=image=>createHash("sha256").update(image.data).digest("hex");

describe("B05: repeated snapcompact preserves archive frames",()=>{
  it("keeps prior image content distinguishable after multiple compactions",async()=>{
    const archive=async secret=>{
      const agent=makeAgent();
      agent.history.push({role:"user",content:secret},{role:"assistant",content:"first evidence ".repeat(1000)},{role:"user",content:"tail"});
      await agent.compactWith("snapcompact","");
      const first=agent.history[1].images.map(hash);
      agent.history.push({role:"assistant",content:"second evidence ".repeat(1000)},{role:"user",content:"second tail"});
      await agent.compactWith("snapcompact","");
      const second=agent.history[1].images.map(hash);
      assert.ok(first.every(digest=>second.includes(digest)),"a second compaction dropped an earlier archive frame");
      assert.ok(agent.history[1].image_tokens>0);
      return second;
    };
    assert.notDeepEqual(await archive("SECRET_A"),await archive("SECRET_B"));
  });

  it("preserves archive assets across save/resume and another compaction",async()=>{
    const root=await mkdtemp(join(tmpdir(),"omr-snap-continuity-"));
    try {
      const session=await createSession(null,"fixture",{rootDir:root});
      const original=makeAgent();original.history.push({role:"user",content:"ORIGINAL_ARCHIVE"},{role:"assistant",content:"evidence ".repeat(2000)},{role:"user",content:"tail"});
      await original.compactWith("snapcompact","");
      const first=original.history[1].images.map(hash);
      await saveSessionHistory(session,original.history,null,"fixture");
      const loaded=await loadSavedSession(session.id,undefined,root);assert.ok(loaded);
      const resumed=makeAgent();resumed.restoreHistory(loaded.messages);
      resumed.history.push({role:"assistant",content:"new ".repeat(2000)},{role:"user",content:"next"});
      await resumed.compactWith("snapcompact","");
      assert.ok(first.every(digest=>resumed.history[1].images.map(hash).includes(digest)));
    } finally {await rm(root,{recursive:true,force:true});}
  });
});
