// Optional local REA integration: authentic export/import across independent continuation sessions.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Rea } from "../dist/rea.js";
import { createSession, forkSession } from "../dist/session.js";
import { SessionRuntime } from "../dist/runtime/sessionRuntime.js";
const root=await mkdtemp(join(tmpdir(),"omr-live-native-resume-"));const controller=new AbortController();const timer=setTimeout(()=>controller.abort(new Error("Native resume integration deadline")),45000);timer.unref();const env={PATH:process.env.PATH,...(process.env.OMR_REA_COMMAND?{OMR_REA_COMMAND:process.env.OMR_REA_COMMAND}:{})};let source,continued,report;
try{
  const input=join(root,"application");await mkdir(input);await writeFile(join(input,"fixture.js"),"export function marker(value){return Number(value)+1;}\n");
  const session=await createSession(null,null,{rootDir:root});source=new SessionRuntime(session,env,()=>({cancelAll:async()=>{}}));source.attachRea(await Rea.connect(session.dir,env,[],{signal:controller.signal,toolTimeoutMs:15000}));
  assert.ok(source.rea.find("export_evidence_bundle"),"Installed REA does not advertise export_evidence_bundle");
  const run=await source.recipes.run("javascript",{input_path:input},controller.signal);assert.equal(run.status,"completed",run.problem);const ids=run.steps.map(step=>step.evidenceId);assert.ok(ids.length>0);await source.captureEvidence();
  const branch=await forkSession(session,[],null,"fixture",{rootDir:root,label:"native-resume"});await source.close();await rm(session.dir,{recursive:true,force:true});
  continued=new SessionRuntime(branch,env,()=>({cancelAll:async()=>{}}));await continued.setOrigin(session,"resume");continued.attachRea(await Rea.connect(branch.dir,env,[],{signal:controller.signal,toolTimeoutMs:15000}));assert.ok(continued.rea.find("import_evidence_bundle"),"Installed REA does not advertise import_evidence_bundle");await continued.restoreEvidence();assert.equal(continued.evidenceOrigin.status,"imported",continued.evidenceOrigin.reason);
  for(const id of ids){assert.ok(continued.importedEvidenceIds.has(id));const found=await continued.rea.call("get_evidence_bundle",{detail:"records",filters:{evidence_id:id},limit:1},{signal:controller.signal});assert.equal(found.isError,false,found.text);assert.equal(found.payload.records[0].evidence_id,id);}
  assert.equal(await continued.recipes.resolveProof(run.id),true,"Copied recipe proof did not validate in the active imported ledger");assert.notEqual(session.id,branch.id);assert.notEqual(session.journalPath,branch.journalPath);
  report={schema:"omr-live-native-resume/v1",passed:true,generatedAt:new Date().toISOString(),sourceSessionId:session.id,continuationSessionId:branch.id,importedEvidenceIds:ids,originStatus:continued.evidenceOrigin.status,sourceDirectoryRemoved:true,recipeProofValid:true,cleanup:"pending",scope:"Installed local REA; inert benign JavaScript fixture; no model/external target"};
}catch(error){report={schema:"omr-live-native-resume/v1",passed:false,error:error instanceof Error?error.message:String(error),cleanup:"pending"};process.exitCode=1;}
finally{clearTimeout(timer);const results=await Promise.allSettled([source?.close(),continued?.close()]);const failed=results.filter(result=>result.status==="rejected");if(failed.length){report.passed=false;report.cleanup=failed.map(result=>String(result.reason)).join("; ");process.exitCode=1;}else report.cleanup="completed";await rm(root,{recursive:true,force:true});}
const index=process.argv.indexOf("--report");if(index>=0)await writeFile(resolve(process.argv[index+1]),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report));
