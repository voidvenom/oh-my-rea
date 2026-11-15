import assert from "node:assert/strict";
import { it } from "node:test";
import { citationMetrics, runOfflineEvaluations } from "../eval/offline.mjs";
it("evaluates real orchestration, rejects unretained success claims and reports duplicate/resume/token metrics",async()=>{
  const report=await runOfflineEvaluations();assert.equal(report.passed,true,JSON.stringify(report.cases.map(({mode,passed,status,completed,predicateVerified,citations,analysisCalls,redundantAnalysisCalls})=>({mode,passed,status,completed,predicateVerified,citations,analysisCalls,redundantAnalysisCalls}))));assert.equal(report.summary.positiveCompletionRate,1);assert.equal(report.summary.negativeClaimRejectionRate,1);assert.equal(report.summary.resumeRediscoveryCalls,0);assert.equal(report.summary.redundantAnalysisCallsDetected,1);assert.ok(report.summary.estimatedPromptTokens>report.summary.reportedFixtureTokens);assert.equal(report.cases.find(row=>row.mode==="false-claim").citations.precision,0);assert.equal(report.cases.find(row=>row.mode==="length").status,"partial");
  assert.deepEqual(citationMetrics("No citation",new Map()),{citations:0,retained:0,precision:null});
});
