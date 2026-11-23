// Release-artifact smoke check. No publish, dependency install, registry request, or external model.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureEnvironment } from "../scripts/fixture-environment.mjs";
const repo=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const root=await mkdtemp(join(tmpdir(),"omr-package-consumer-"));let report;
const run=(command,args,cwd=repo)=>{const result=spawnSync(command,args,{cwd,encoding:"utf8",timeout:30000,env:{...fixtureEnvironment(),HOME:root,USERPROFILE:root,XDG_CONFIG_HOME:root,npm_config_cache:join(root,"npm-cache"),npm_config_userconfig:join(root,"empty-npmrc"),npm_config_update_notifier:"false"}});assert.equal(result.status,0,`${command}: ${result.error?.message??""}\n${result.stdout}\n${result.stderr}`);return result.stdout;};
try{
  await writeFile(join(root,"empty-npmrc"),"");
  const packed=JSON.parse(run("npm",["pack","--json","--ignore-scripts","--pack-destination",root]))[0];
  assert.ok(packed.files.some(file=>file.path==="dist/sdk.js"));assert.ok(packed.files.some(file=>file.path==="dist/sdk.d.ts"));assert.ok(!packed.files.some(file=>file.path.startsWith(".planning/")));
  const installed=join(root,"node_modules","oh-my-rea");await mkdir(installed,{recursive:true});run("tar",["-xzf",join(root,packed.filename),"--strip-components=1","-C",installed]);
  for(const directory of["@types","@modelcontextprotocol"]){await symlink(join(repo,"node_modules",directory),join(root,"node_modules",directory),"dir");}
  const manifest=JSON.parse(await readFile(join(installed,"package.json"),"utf8"));assert.equal(manifest.main,"./dist/main.js");assert.equal(join(installed,manifest.bin.omr),join(installed,"bin","omr.js"));assert.equal(manifest.exports["./sdk"].types,"./dist/sdk.d.ts");
  const consumer=await readFile(join(repo,"test","fixtures","sdk-consumer.mts"),"utf8");await writeFile(join(root,"consumer.mts"),consumer);
  run(process.execPath,[join(repo,"node_modules","typescript","bin","tsc"),"--noEmit","--module","NodeNext","--moduleResolution","NodeNext","--target","ES2024","--strict","--skipLibCheck",join(root,"consumer.mts")],root);
  const program=`import assert from 'node:assert/strict';import {createRuntime} from 'oh-my-rea/sdk';const before=process.listenerCount('SIGTERM');const runtime=await createRuntime({cwd:process.cwd(),sessionsRootDir:process.cwd()+'/sessions',env:{PATH:process.env.PATH,XDG_CONFIG_HOME:process.cwd()},noModel:true});try{const result=await runtime.command('/state update 0 {"goal":"packaged SDK"}');assert.equal(result.exitCode,0);assert.equal((await runtime.snapshot()).task.goal,'packaged SDK');assert.ok((await runtime.readEvents()).length>0);console.log(JSON.stringify({status:result.outcome.status,exitCode:result.exitCode,events:true}));}finally{await runtime.close();assert.equal(process.listenerCount('SIGTERM'),before);}`;
  await writeFile(join(root,"consumer.mjs"),program);const consumerResult=JSON.parse(run(process.execPath,[join(root,"consumer.mjs")],root).trim());
  const version=run(process.execPath,[join(installed,"bin","omr.js"),"--version"],root).trim();assert.equal(version,manifest.version);const help=run(process.execPath,[join(installed,"bin","omr.js"),"--help"],root);assert.match(help,/^Usage:/m);
  const sdkSha256=createHash("sha256").update(await readFile(join(installed,"dist","sdk.js"))).digest("hex");assert.equal(sdkSha256,createHash("sha256").update(await readFile(join(repo,"dist","sdk.js"))).digest("hex"));
  report={schema:"omr-package-consumer/v1",passed:true,generatedAt:new Date().toISOString(),sdkSha256,package:{name:manifest.name,version:manifest.version,integrity:packed.integrity,fileCount:packed.files.length,size:packed.size},consumer:consumerResult,typecheck:"passed",cli:{version,help:"passed"},dependencies:"existing local dependencies linked; no install or registry access"};
}catch(error){report={schema:"omr-package-consumer/v1",passed:false,error:error instanceof Error?error.message:String(error)};process.exitCode=1;}
finally{await rm(root,{recursive:true,force:true});}
const index=process.argv.indexOf("--report");if(index>=0)await writeFile(resolve(process.argv[index+1]),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report));
