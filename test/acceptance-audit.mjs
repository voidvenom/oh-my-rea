// Requirement/proof index for this engineering change; does not replace semantic regression tests.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const plan=".planning/2026-11-11-omr-engineering-evolution";
const rows=[
  ["B01","Script publish symlink/traversal reddi, atomik inode",["src/exec.ts"],["test/engineering-regressions.test.mjs"]],
  ["B02","Tek SessionRuntime ve bütün bileşenlerle fork/resume",["src/runtime/sessionRuntime.ts","src/runtime/context.ts","src/session.ts"],["test/session-runtime.test.mjs"]],
  ["B03","FIFO queued cancel/steer ve DAG sonucu",["src/subagent.ts","src/concurrency.ts"],["test/subagent-lifecycle.test.mjs"]],
  ["B04","Model capability/window/output/image/schema admission",["src/capabilities.ts","src/agent.ts"],["test/model-context.test.mjs"]],
  ["B05","Özgün history/frame korunması ve bounded retrieval",["src/agent.ts","src/contextArchive.ts","src/session.ts"],["test/snapcompact-continuity.test.mjs","test/context-archive.test.mjs"]],
  ["B06","Ortak durable usage/budget; retry/failover/summary",["src/usage.ts","src/model.ts"],["test/usage-ledger.test.mjs","test/session-runtime.test.mjs"]],
  ["B07","Gerçek SDK init/catalog/abort owned cleanup",["src/rea.ts","src/ownedProcess.ts"],["test/engineering-regressions.test.mjs","test/resources.test.mjs"]],
  ["B08","Typed command outcome ve0/1/2/130 exit",["src/outcome.ts","src/runtime/commandRegistry.ts","src/runtime.ts"],["test/execution-outcomes.test.mjs","test/registry-drift.test.mjs"]],
  ["B09","finishReason/partial ve truncated tool dispatch engeli",["src/agent.ts","src/model.ts"],["test/execution-outcomes.test.mjs"]],
  ["B10","Structured/mixed/image/resource MCP result kayıpsız normalizasyon",["src/rea.ts","src/broker.ts"],["test/mcp-results.test.mjs"]],
  ["B11","Journal incremental single-flight",["src/journal.ts"],["test/engineering-regressions.test.mjs"]],
  ["B12","Client reuse, config invalidation, sticky failover",["src/runtime/modelController.ts","src/model.ts"],["test/model-lifecycle.test.mjs"]],
  ["B13","Nested history doğrulama/repair ve asset restore",["src/history.ts","src/session.ts"],["test/session-boundaries.test.mjs"]],
  ["B14","Local launch proxy scope; Camofox unsupported/unverified routing",["src/browser.ts"],["test/browser-lifecycle.test.mjs"]],
  ["B15","HTTP/body/shared deadline/abort ve owned process cleanup",["src/browser.ts","src/concurrency.ts"],["test/browser-lifecycle.test.mjs","test/resources.test.mjs"]],
  ["B16","Native opaque compact unsupported; custom text+soft fallback",["src/model.ts","src/agent.ts","src/compaction.ts"],["test/remote-compaction.test.mjs"]],
  ["B17","Tam Markdown/JSON export ve ayrı bounded view",["src/runtime/handlers/sessionHandlers.ts"],["test/session-boundaries.test.mjs"]],
  ["R1","Writer-fair target lease/epoch ve queued binding guard",["src/concurrency.ts","src/runtime/sessionRuntime.ts","src/subagent.ts"],["test/session-runtime.test.mjs"]],
  ["R2","fsync intent/result, uncertain effect, explicit reconciliation",["src/execution.ts","src/runtime/sessionRuntime.ts"],["test/execution-store.test.mjs","test/session-runtime.test.mjs"]],
  ["A01","TaskState goal/constraint/decision/acceptance/work/artifact",["src/taskState.ts","src/localTools.ts"],["test/task-state.test.mjs","test/context-archive.test.mjs"]],
  ["A02","Version/hash/env-bound Forge, exact fixtures, explicit lifecycle",["src/forge.ts","src/jsonSchema.ts"],["test/forge.test.mjs"]],
  ["A03","MCP list_changed, revision/cache ve tutarlı alias/schema/hint/dispatch",["src/rea.ts","src/broker.ts"],["test/catalog-lifecycle.test.mjs"]],
  ["A04","Browser context/vision/ownership/historical recovery scope",["src/browser.ts","src/browserContext.ts"],["test/browser-context.test.mjs"]],
  ["A05","Versioned replayable recipe entry/exit/native proof",["src/recipes.ts","src/evidence.ts"],["test/recipes.test.mjs"]],
  ["A06","Machine coverage, Unknown ayrımı ve measured progress",["src/coverage.ts","src/progress.ts"],["test/coverage-progress.test.mjs"]],
  ["A07","Completion/citation/redundancy/resume/token offline eval",["eval/offline.mjs"],["test/offline-eval.test.mjs"]],
  ["A08","Gerçek katalog/native startup/TTFT/tool/p50-p95/RSS benchmark",["bench/platform.mjs","bench/worker.mjs","bench/compare.mjs"],[]],
  ["A09","Global model/REA/browser/script/shell/process admission",["src/resources.ts","src/ownedProcess.ts"],["test/resources.test.mjs"]],
  ["A10","Ölçüme göre schema sync/TaskState cache ve archive projection",["src/broker.ts","src/taskState.ts","src/contextArchive.ts"],["test/catalog-lifecycle.test.mjs","test/context-archive.test.mjs"]],
  ["A11","Kararlı ./sdk typed facade/event cursor ve paket consumer",["src/sdk.ts","package.json"],["test/sdk.test.mjs"]],
  ["A12","Conditional learned-router/multiMCP kararı ve capability sınırları",["README.md","src/broker.ts","src/rea.ts"],["test/omr.test.mjs"]],
];
const digest=value=>createHash("sha256").update(value).digest("hex");
const paths=[];const walk=async directory=>{for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await walk(path);else if(path.endsWith(".ts"))paths.push(path);}};await walk("src");const hash=createHash("sha256");for(const path of paths.sort()){hash.update(path.replaceAll("\\","/"));hash.update(await readFile(path));}const sourceFingerprint=hash.digest("hex");
const load=async name=>JSON.parse(await readFile(join(plan,name),"utf8"));
const [baseline,benchmark,comparison,evaluation,episode,consumer,nativeResume]=await Promise.all(["benchmark-baseline.json","benchmark-after.json","benchmark-comparison.json","offline-eval.json","live-browser-episode-final.json","package-consumer.json","live-native-resume.json"].map(load));
assert.equal(benchmark.status,"completed");assert.equal(baseline.status,"completed");assert.equal(benchmark.sourceFingerprint,sourceFingerprint);assert.equal(evaluation.sourceFingerprint,sourceFingerprint);assert.equal(comparison.after.sourceFingerprint,sourceFingerprint);assert.equal(evaluation.passed,true);assert.equal(episode.passed,true);assert.equal(episode.cleanup,"completed");assert.ok(episode.ownedBrowserProcessesObserved>1);assert.equal(consumer.passed,true);assert.equal(consumer.sdkSha256,digest(await readFile("dist/sdk.js")));
assert.equal(nativeResume.passed,true);assert.equal(nativeResume.cleanup,"completed");assert.equal(nativeResume.originStatus,"imported");assert.equal(nativeResume.sourceDirectoryRemoved,true);assert.equal(nativeResume.recipeProofValid,true);
const log=await readFile(join(plan,"test-final.log"),"utf8");const count=key=>Number(new RegExp(`^[#ℹ]?\\s*${key} (\\d+)\\s*$`,"m").exec(log)?.[1]);const tests=count("tests"),passed=count("pass"),failed=count("fail");assert.ok(tests>=205);assert.equal(passed,tests);assert.equal(failed,0);assert.doesNotMatch(log,/error TS\d+/);
const before=JSON.parse(execFileSync("git",["show","HEAD:package.json"],{encoding:"utf8"})),pkg=JSON.parse(await readFile("package.json","utf8"));assert.deepEqual(pkg.dependencies,before.dependencies);assert.deepEqual(pkg.devDependencies,before.devDependencies);assert.equal(execFileSync("git",["diff","--name-only","--","src/prompts.ts","src/guide.ts","package-lock.json"],{encoding:"utf8"}).trim(),"");
const evidence=[];for(const[id,criterion,implementation,verification]of rows){const files=[];for(const path of[...implementation,...verification]){assert.ok((await stat(path)).isFile());files.push({path,sha256:digest(await readFile(path))});}evidence.push({id,criterion,status:id==="A12"?"conditional-decision-verified":"implemented-verified",implementation,verification,files});}
const report={schema:"omr-acceptance-audit/v1",passed:true,generatedAt:new Date().toISOString(),sourceFingerprint,head:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),branch:execFileSync("git",["branch","--show-current"],{encoding:"utf8"}).trim(),verification:{tests,passed,failed,typecheck:"passed (recorded progress; final npm test also builds)",offlineEpisodes:evaluation.cases.length,benchmark:"before/after completed, raw samples and fingerprints",packageConsumer:"actual npm pack + isolated TypeScript/Node/CLI",liveEpisode:"localhost installed Chromium + local REA; owned group cleaned"},unchanged:{dependencies:true,devDependencies:true,packageLock:true,domainPrompts:true},conditionalDecision:{router:"Mevcut route schema12–13k vs full117450; learned/multi-model routing için fayda kanıtı yok",multiMcp:"Tek REA backend; gerçek ikinci backend gereksinimi yok, ReaPort adapter ve collision/lifecycle seam korunuyor"},limitations:["Offline eval scripted provider orchestration ölçer; uzak LLM task success/semantic prose doğruluğu ölçülmedi","Native Responses opaque compaction Chat/Anthropic transportta desteklenmiyor; custom text/soft fallback açık","Camofox routing server-managed/unverified; canlı egress kanıtı yok","Concurrency/process admission OS RSS/CPU/filesystem sandbox değildir; Linux setsid yoksa MCP direct-child fallback","Live browser coverage attach-limited/policy-filtered;21 semantic Unknown pipeline completion içinde açık kaldı","Paket publish/commit/push/dependency upgrade yapılmadı"],requirements:evidence};
report.verification.nativeResume="actual REA authenticated import and copied recipe proof after source directory removal";
report.receipts=await Promise.all(["test-final.log","offline-eval.json","benchmark-baseline.json","benchmark-after.json","benchmark-comparison.json","package-consumer.json","live-browser-episode-final.json","live-native-resume.json"].map(async name=>({path:join(plan,name),sha256:digest(await readFile(join(plan,name)))})));
const index=process.argv.indexOf("--report");if(index>=0)await writeFile(resolve(process.argv[index+1]),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify({passed:true,sourceFingerprint,requirements:evidence.length,verification:report.verification}));
