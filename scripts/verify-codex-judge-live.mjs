/** Explicit opt-in grading of saved synthetic executions; never reexecutes tools. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {configuredModelRole} from '../dist/service/config.js';
import {loadEvalPack} from '../dist/eval-pack.js';
import {ModelRuntimeComparisonJudge} from '../dist/runtime-comparison-judge.js';

const [jobPath,output]=process.argv.slice(2);
assert(jobPath&&output,'Usage: verify-codex-judge-live.mjs saved-synthetic-job.json output-directory');
assert.equal(process.env.FINANCE_EVAL_JUDGE_PROVIDER,'codex_cli');
assert.equal(process.env.FINANCE_EVAL_JUDGE_MODEL,'gpt-6-astra');
await mkdir(output,{recursive:true,mode:0o700});
const started=Date.now(),trace=[];
try{
  const pack=await loadEvalPack(path.resolve('packs/finance/native-readonly-balance/eval.yaml'));
  const job=JSON.parse(await readFile(jobPath,'utf8'));
  const item=job.report.cases[0],evalCase=pack.cases.find(c=>c.caseId===item.caseId);
  assert(evalCase,'Saved case must match the pinned synthetic pack');
  assert.equal(item.left.status,'completed');assert.equal(item.right.status,'completed');
  const role=configuredModelRole('JUDGE');
  assert(role.adapter);assert.equal(role.model.modelId,'gpt-6-astra');
  const adapter={adapterId:role.adapter.adapterId,complete:async request=>{
    const response=await role.adapter.complete(request);
    trace.push({requestId:request.requestId,requestedModel:request.model.modelId,
      responseModel:response.modelId,usage:response.usage,content:response.content});
    await writeFile(path.join(output,'responses.json'),JSON.stringify(trace,null,2));
    return response;
  }};
  const result=await new ModelRuntimeComparisonJudge(adapter,role.model).compare({evalCase,
    left:item.left,right:item.right,profile:pack.judgeProfile});
  await writeFile(path.join(output,'assessment.json'),JSON.stringify(result,null,2));
  assert.equal(result.runtimeComparison?.left.status,'assessed');
  assert.equal(result.runtimeComparison?.right.status,'assessed');
  const report={status:'PASS',scope:'REAL_JUDGE_OF_SAVED_SYNTHETIC_RUN',judge:role.model,
    sourceJobId:job.jobId,modelCompletions:trace.length,elapsedMs:Date.now()-started,
    businessReexecution:false,humanProfessionalAcceptance:'NOT_ASSESSED'};
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}catch(error){
  await writeFile(path.join(output,'report.json'),JSON.stringify({status:'FAIL',error:String(error),
    elapsedMs:Date.now()-started,businessReexecution:false},null,2));
  console.error(String(error));process.exitCode=1;
}
