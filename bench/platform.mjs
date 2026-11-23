import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { arch, cpus, loadavg, platform, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureEnvironment } from "../scripts/fixture-environment.mjs";
import { terminateOwnedProcess } from "../dist/ownedProcess.js";
import { replaceFile } from "../dist/platformFs.js";

const get = (flag, fallback) => { const index = process.argv.indexOf(flag); return index < 0 ? fallback : process.argv[index + 1]; };
const samples = Number(get("--samples","10")); if (!Number.isInteger(samples) || samples < 5 || samples > 50) throw new Error("--samples must be 5–50");
const real = process.argv.includes("--real-rea"); const root = await mkdtemp(join(tmpdir(),"omr-benchmark-driver-"));
const cwd = fileURLToPath(new URL("..",import.meta.url));
const stats = values => { const sorted = values.filter(Number.isFinite).sort((a,b) => a-b); return { n: sorted.length, min: sorted[0] ?? null, p50: sorted[Math.ceil(sorted.length*0.5)-1] ?? null, p95: sorted[Math.ceil(sorted.length*0.95)-1] ?? null, max: sorted.at(-1) ?? null }; };
const env = {
  ...fixtureEnvironment(), HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, "config"),
  ...(process.env.OMR_REA_COMMAND ? { OMR_REA_COMMAND: process.env.OMR_REA_COMMAND } : {}),
};
const child = args => new Promise((resolve,reject) => {
  const start = performance.now(); const processChild = spawn(process.execPath,args,{cwd,env,stdio:["ignore","pipe","pipe"],detached:platform()!=="win32"}); let stdout="",stderr="";
  const stop = () => { void terminateOwnedProcess(processChild.pid, platform() !== "win32", processChild, 0).catch(() => {}); };
  const timer = setTimeout(stop,60_000); timer.unref();
  processChild.stdout.on("data",chunk=>{stdout+=chunk;if(stdout.length>16_777_216)stop();}); processChild.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-65536);});
  processChild.once("error",error=>{clearTimeout(timer);reject(error);}); processChild.once("close",(code,signal)=>{clearTimeout(timer); if(code!==0)reject(new Error(`Benchmark child failed (${code??signal}): ${stderr}`)); else resolve({wallMs:performance.now()-start,stdout,stderr});});
});
const worker = async (mode,options={}) => { const run=await child(["--expose-gc","bench/worker.mjs",mode,JSON.stringify(options)]); return {wallMs:run.wallMs,...JSON.parse(run.stdout.trim())}; };
const fingerprint = createHash("sha256");
const sourcePaths=[];
const walk=async directory=>{for(const entry of await readdir(join(cwd,directory),{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await walk(path);else if(entry.name.endsWith(".ts"))sourcePaths.push(path);}};
await walk("src");for(const path of sourcePaths.sort()){fingerprint.update(path.replaceAll("\\","/"));fingerprint.update(await readFile(join(cwd,path)));}
const harness=createHash("sha256");for(const path of ["bench/platform.mjs","bench/worker.mjs","bench/memory-probe.cjs","scripts/fixture-environment.mjs"]){harness.update(path);harness.update(await readFile(join(cwd,path)));}
const report = { schema:"omr-benchmark/v1", status:"running", generatedAt:new Date().toISOString(), sourceFingerprint:fingerprint.digest("hex"),harnessFingerprint:harness.digest("hex"), environment:{node:process.version,platform:platform(),arch:arch(),logicalCpus:cpus().length,totalMemoryBytes:totalmem(),loadAverage:loadavg()}, method:{samples,percentile:"nearest-rank",coldMeaning:"fresh Node process and module cache; OS caches are not flushed",model:"controlled localhost SSE, no external API",memory:"Node process high-water RSS KiB; native child RSS is a Linux /proc sample, not its peak"},raw:{},summary:{} };
const out=get("--out",null);
const persist=async()=>{if(out){const path=resolve(out);await writeFile(`${path}.tmp`,`${JSON.stringify(report,null,2)}\n`);await replaceFile(`${path}.tmp`,path);}};
try {
  for(const flag of ["--version","--help"]){const rows=[];for(let index=0;index<samples;index++){const run=await child(["--require","./bench/memory-probe.cjs","bin/omr.js",flag]); const resource=JSON.parse(/OMR_BENCH_RESOURCE (.+)/.exec(run.stderr)[1]);rows.push({wallMs:run.wallMs,...resource});}report.raw[`cli${flag}`]=rows;report.summary[`cli${flag}`]={wallMs:stats(rows.map(row=>row.wallMs)),maxRssKiB:stats(rows.map(row=>row.maxRssKiB))};await persist();console.error(`measured CLI ${flag}`);}
  const imports=[];for(let index=0;index<samples;index++)imports.push(await worker("import"));report.raw.runtimeImport=imports;report.summary.runtimeImport={importMs:stats(imports.map(row=>row.importMs)),wallMs:stats(imports.map(row=>row.wallMs)),maxRssKiB:stats(imports.map(row=>row.memory.maxRssKiB))};await persist();console.error("measured runtime import");
  const catalogPath=join(root,"catalog.json");report.raw.catalog=await worker("catalog",{real,path:catalogPath});await persist();console.error("measured catalog and verified worker cleanup");
  const mcps=[];for(let index=0;index<samples;index++)mcps.push(await worker("mcp",{real}));report.raw.mcp=mcps;report.summary.mcp={source:real?"configured/local REA":"controlled stdio fixture",connectMs:stats(mcps.map(row=>row.connectMs)),firstToolMs:stats(mcps.map(row=>row.firstToolMs)),rawToolMs:stats(mcps.flatMap(row=>row.rawMs)),durableToolMs:stats(mcps.flatMap(row=>row.durableMs)),parentMaxRssKiB:stats(mcps.map(row=>row.memory.maxRssKiB)),nativeChildRssKiB:stats(mcps.map(row=>row.nativeChildRssKiB))};console.error("measured MCP lifecycle and durable tool calls");
  await persist();
  report.raw.broker=await worker("broker",{path:catalogPath});report.summary.broker={catalogCount:report.raw.broker.catalogCount,fullEstimatedSchemaTokens:report.raw.broker.fullEstimatedSchemaTokens,routes:report.raw.broker.cases.map(row=>({route:row.route,definitionCount:row.definitionCount,estimatedSchemaTokens:row.estimatedSchemaTokens,schemaBytes:row.schemaBytes,coldMs:stats(row.coldMs),warmMs:stats(row.warmMs)}))};await persist();console.error("measured routed schemas");
  report.raw.model=await worker("model",{samples});report.summary.model={serverFirstDeltaDelayMs:10,modes:["raw","durable-usage"].map(mode=>({mode,ttftMs:stats(report.raw.model.samples.filter(row=>row.mode===mode).map(row=>row.ttftMs)),totalMs:stats(report.raw.model.samples.filter(row=>row.mode===mode).map(row=>row.totalMs))}))};console.error("measured loopback TTFT");
  await persist();
  report.raw.context=await worker("context");report.summary.context={taskGoalChars:report.raw.context.taskGoalChars,taskNoteMs:stats(report.raw.context.taskNoteMs),compactionRounds:report.raw.context.compactionRounds,maxRssKiB:report.raw.context.memory.maxRssKiB};await persist();console.error("measured repeated compaction");
  const replay=[];
  for(const records of [100,1000,5000]){
    const path=join(root,`trace-${records}.jsonl`);
    const rows=Array.from({length:records},(_,index)=>{
      const block=Math.floor(index/4),id=`invocation-${block}`,text="x".repeat(1000),args={index:block};let type,data;
      if(index%4===0){type="invocation.started";data={id,backend:"rea",tool:"fixture",args,argsDigest:createHash("sha256").update(JSON.stringify(args)).digest("hex"),readOnly:true,binding:null,startedAt:"2026-11-11T00:00:00.000Z"};}
      else if(index%4===1){type="invocation.completed";data={id,result:{isError:false,payload:{evidence_id:`ev_${createHash("sha256").update(String(block)).digest("hex")}`,operation:"fixture",provider:{id:"fixture"},normalized_result:{index:block,text}}}};}
      else if(index%4===2){type="conversation.append";data={scope:"primary",messages:[{role:"user",content:text},{role:"assistant",content:text}]};}
      else if(block%100===0){type="projection.reset";data={scope:"primary",messages:[{role:"user",content:"bounded projection"}]};}
      else{type="benchmark.observation";data={text};}
      return{schema:1,seq:index+1,id:`event-${index}`,at:"2026-11-11T00:00:00.000Z",sessionId:"fixture",type,data};
    });
    await writeFile(path,rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
    for(let index=0;index<Math.min(samples,5);index++)replay.push(await worker("replay",{records,path}));
  }
  report.raw.replay=replay;report.summary.replay=[100,1000,5000].map(records=>({records,replayMs:stats(replay.filter(row=>row.records===records).map(row=>row.replayMs)),maxRssKiB:stats(replay.filter(row=>row.records===records).map(row=>row.memory.maxRssKiB))}));
  report.status="completed";await persist();
  console.log(JSON.stringify({schema:report.schema,sourceFingerprint:report.sourceFingerprint,summary:report.summary}));
} catch(error){report.status="failed";report.error=error instanceof Error?error.message:String(error);await persist();throw error;
} finally {await rm(root,{recursive:true,force:true});}
