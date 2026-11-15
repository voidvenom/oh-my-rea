import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "oh-my-rea/sdk";
import { FakeModel, FakeRea } from "../dist/testing/fakes.js";
import { estimateRequestTokens } from "../dist/capabilities.js";
import { argumentDigest } from "../dist/execution.js";

const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record={operation:"search_strings",provider:{id:"controlled-offline-fixture"},normalized_result:{value:"feature_enabled"}};
record.evidence_id=`ev_${hash(record)}`;
const fabricated=`ev_${"f".repeat(64)}`;
export const citationMetrics=(text,records)=>{const citations=[...text.matchAll(/\bev_[0-9a-f]{64}\b/g)].map(match=>match[0]);const retained=citations.filter(id=>records.has(id)).length;return{citations:citations.length,retained,precision:citations.length?retained/citations.length:null};};

export const runOfflineEvaluations=async()=>{
  const root=await mkdtemp(join(tmpdir(),"omr-offline-eval-"));const cases=[];
  try{
    for(const mode of ["direct","duplicate","false-claim","length","resume-compacted"]){
      const calls=[],requests=[],ports=[],diagnostics=[];let runtime;const originRecords=new Map();let phase="source";
      const env={PATH:process.env.PATH,XDG_CONFIG_HOME:root,OPENAI_API_KEY:"offline-fixture",OMR_MODEL:"gpt-4.1",OMR_NET_WAIT_MS:"0",OMR_COMPACT_KEEP_TOKENS:"1000"};
      const adapters={
        connectRea:async directory=>{
          const records=new Map();const rea=new FakeRea(directory,{extraTools:[{name:"import_evidence_bundle",readOnly:false}],handlers:{
            search_strings:args=>{calls.push({phase,name:"search_strings",args});records.set(record.evidence_id,record);originRecords.set(record.evidence_id,record);return record;},
            get_evidence_bundle:args=>{const selected=[...records.values()].filter(value=>!args.filters?.evidence_id||args.filters.evidence_id===value.evidence_id);return{total_retained_records:records.size,matching_records:selected.length,records:args.detail==="records"?selected:[]};},
            list_unknowns:()=>({items:[],total:0,next_offset:null}),
            export_evidence_bundle:async args=>{await writeFile(args.path,JSON.stringify({records:[...records.values()],unknowns:[]}));return{path:args.path,records_exported:records.size};},
            import_evidence_bundle:async args=>{const bundle=JSON.parse(await readFile(args.path,"utf8"));for(const value of bundle.records)records.set(value.evidence_id,value);return{records_added:records.size};},
          }});ports.push({rea,records});return rea;
        },
        createModelClient:()=>{
          const model=new FakeModel((messages,tools,index)=>{
            requests.push({phase,estimatedPromptTokens:estimateRequestTokens(messages,tools),schemaCount:tools.length});
            if(mode==="false-claim")return{content:`Claimed success: feature_enabled ${fabricated}`};
            const seen=messages.some(message=>(message.role==="tool"||message.role==="assistant"||message.content?.includes("<snapcompact>"))&&message.content?.includes(record.evidence_id));
            if(!seen||(mode==="duplicate"&&index===1))return{toolCalls:[{name:"search_strings",arguments:{query:"feature_enabled"}}]};
            return{content:`Observed feature_enabled ${record.evidence_id}${mode==="resume-compacted"&&phase==="source"?"\n"+"retained fixture detail ".repeat(1000):""}`};
          });
          if(mode==="length"){const stream=model.stream.bind(model);model.stream=async(...args)=>{const result=await stream(...args);return result.toolCalls.length?result:{...result,finishReason:"length"};};}
          return model;
        },
      };
      try{
        runtime=await createRuntime({cwd:root,sessionsRootDir:root,env,adapters,onOutput:output=>{try{const value=JSON.parse(output.text);if(value.type==="error"||value.type==="persistence.warning")diagnostics.push(value);}catch{}}});
        const goal="Inspect the controlled feature marker and cite the retained native record.";
        const setup=await runtime.command(`/state update 0 ${JSON.stringify({goal,acceptance:[{id:"feature",text:"Retained record contains feature_enabled",verification:{kind:"evidence-equals",ref:record.evidence_id,pointer:"/normalized_result/value",equals:"feature_enabled"}}]})}`);
        if(setup.exitCode!==0)throw new Error(`Eval setup failed: ${JSON.stringify(setup)}`);
        let result=await runtime.run(goal);let compaction=null,resumeRediscoveryCalls=null;
        if(mode==="resume-compacted"){
          const source=result.session.id;await runtime.run("Record the retained result before compaction.");const compacted=await runtime.command("/compact snapcompact");if(compacted.exitCode!==0||!compacted.commandResult?.summarizedMessages)throw new Error(`Eval must actually compact messages: ${JSON.stringify(compacted)}`);compaction=compacted.commandResult;
          await runtime.close();phase="resumed";runtime=await createRuntime({cwd:root,sessionsRootDir:root,env,adapters,resume:source});const before=calls.length;result=await runtime.run("Continue using retained observations and the original acceptance condition.");resumeRediscoveryCalls=calls.length-before;
        }
        const coverage=await runtime.command("/coverage");if(coverage.exitCode!==0)throw new Error("Eval coverage failed");
        const citations=citationMetrics(result.text,ports.at(-1).records);
        const predicateVerified=coverage.commandResult?.goalStatus==="acceptance_conditions_met";
        const completed=result.outcome.status==="completed"&&predicateVerified&&citations.citations>0&&citations.precision===1&&result.text.includes("feature_enabled");
        const unique=new Set();let redundant=0;for(const call of calls){const key=`${call.name}:${argumentDigest(call.args)}`;if(unique.has(key))redundant++;unique.add(key);}
        const expectedCompleted=mode!=="false-claim"&&mode!=="length";const snapshot=await runtime.snapshot();
        const metrics={mode,status:result.outcome.status,completed,expectedCompleted,predicateVerified,citations,analysisCalls:calls.length,redundantAnalysisCalls:redundant,resumeRediscoveryCalls,estimatedPromptTokens:requests.reduce((sum,row)=>sum+row.estimatedPromptTokens,0),reportedFixtureTokens:snapshot.usage.totalTokens-snapshot.usage.estimatedTokens,conservativeChargedTokens:snapshot.usage.estimatedTokens,ledgerTotalTokens:snapshot.usage.totalTokens,modelRequests:requests.length,compaction,requests,diagnostics};
        metrics.passed=completed===expectedCompleted&&citations.precision===(mode==="false-claim"?0:1)&&redundant===(mode==="duplicate"?1:0)&&(resumeRediscoveryCalls===null||resumeRediscoveryCalls===0);
        cases.push(metrics);
      }finally{await runtime?.close();}
    }
    const sourceHash=createHash("sha256");const paths=[];const walk=async directory=>{for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await walk(path);else if(path.endsWith(".ts"))paths.push(path);}};await walk("src");for(const path of paths.sort()){sourceHash.update(path);sourceHash.update(await readFile(path));}
    const positive=cases.filter(row=>row.expectedCompleted),negative=cases.filter(row=>!row.expectedCompleted);
    return{schema:"omr-offline-eval/v1",generatedAt:new Date().toISOString(),sourceFingerprint:sourceHash.digest("hex"),harnessFingerprint:createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),method:{provider:"scripted in-process model and native fixture; no external model/API",completion:"typed completed outcome + exact active-ledger acceptance predicate + retained citation + fixture value",citations:"precision over citation occurrences in final answer against active native fixture ledger",redundancy:"repeated read-only analysis name+canonical arguments against the unchanged fixture",resume:"analysis calls after actual SDK compact/resume continuation",tokens:"estimated stream prompt+schemas, synthetic provider stream usage (160 tokens/request), and conservative ledger charges without provider usage are separate",limitation:"Tests orchestration invariants, not model intelligence, semantic grounding of arbitrary prose, recall or real-provider task success"},passed:cases.every(row=>row.passed),summary:{episodes:cases.length,positiveCompletionRate:positive.filter(row=>row.completed).length/positive.length,negativeClaimRejectionRate:negative.filter(row=>!row.completed).length/negative.length,positiveCitationPrecision:positive.reduce((sum,row)=>sum+row.citations.retained,0)/positive.reduce((sum,row)=>sum+row.citations.citations,0),resumeRediscoveryCalls:cases.find(row=>row.mode==="resume-compacted").resumeRediscoveryCalls,redundantAnalysisCallsDetected:cases.find(row=>row.mode==="duplicate").redundantAnalysisCalls,estimatedPromptTokens:cases.reduce((sum,row)=>sum+row.estimatedPromptTokens,0),reportedFixtureTokens:cases.reduce((sum,row)=>sum+row.reportedFixtureTokens,0),conservativeChargedTokens:cases.reduce((sum,row)=>sum+row.conservativeChargedTokens,0)},cases};
  }finally{await rm(root,{recursive:true,force:true});}
};

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=await runOfflineEvaluations();const index=process.argv.indexOf("--out");if(index>=0){const path=resolve(process.argv[index+1]);await writeFile(`${path}.tmp`,JSON.stringify(report,null,2)+"\n");await rename(`${path}.tmp`,path);}console.log(JSON.stringify({passed:report.passed,summary:report.summary,cases:report.cases.map(({mode,passed,status,completed,citations,analysisCalls,resumeRediscoveryCalls})=>({mode,passed,status,completed,citations,analysisCalls,resumeRediscoveryCalls}))}));if(!report.passed)process.exitCode=1;
}
