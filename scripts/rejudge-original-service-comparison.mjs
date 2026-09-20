/** Recheck saved real executions with the real comparison model, preserving the original run. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {configuredModelRole} from '../dist/service/config.js';
import {ModelServiceComparisonJudge} from '../dist/service-comparison-judge.js';
const root=process.cwd(),source=path.resolve(process.argv[2]);
const config=JSON.parse(await readFile(path.join(root,'.runtime.local.json'),'utf8'));
const [modelId,model]=Object.entries(config.models).find(([,value])=>value.enabled!==false);
process.env.FINANCE_EVAL_JUDGE_PROVIDER='openai_compatible';process.env.FINANCE_EVAL_JUDGE_BASE_URL=model.baseUrl;process.env.FINANCE_EVAL_JUDGE_API_KEY=model.apiKey;
process.env.FINANCE_EVAL_JUDGE_MODEL=model.upstreamModelId??modelId;process.env.FINANCE_EVAL_JUDGE_REQUEST_DEFAULTS=JSON.stringify({...model.extraBody,max_tokens:32000});
const output=path.join(root,'reports','original-service-rejudge-'+new Date().toISOString().replace(/[:.]/gu,'-'));await mkdir(output,{recursive:true});
const role=configuredModelRole('JUDGE'),trace=[];
async function save(name,value){let text=JSON.stringify(value,null,2);for(const secret of Object.values(config.models).map(v=>v.apiKey).filter(Boolean))text=text.replaceAll(secret,'[redacted]');await writeFile(path.join(output,name),text)}
const adapter={adapterId:role.adapter.adapterId,complete:async request=>{const result=await role.adapter.complete(request);trace.push({requestId:request.requestId,messages:request.messages,content:result.content});await save('model-trace.json',trace);return result}};
try{
 const job=JSON.parse(await readFile(path.join(source,'job.json'),'utf8'));
 const migration=JSON.parse(await readFile(path.join(source,'migration-report.json'),'utf8'));
 const experiment=migration.experiments.find(item=>item.jobId===job.jobId);const judge=new ModelServiceComparisonJudge(adapter,role.model),results=[];
 for(const result of job.report.cases){
  assert.equal(result.left.status,'completed');assert.equal(result.right.status,'completed');
  const evalCase=experiment.suiteSnapshot.cases.find(item=>item.caseId===result.caseId);
  const assessed=await judge.compare({evalCase,left:result.left,right:result.right,profile:experiment.suiteSnapshot.judgeProfile});
  results.push({caseId:result.caseId,originalAnswer:result.left.output,candidateAnswer:result.right.output,judge:assessed});await save('reassessment.json',results);
  assert.equal(assessed.serviceComparison.verdict,result.caseId==='equivalent'?'PASS':'FAIL');console.log(result.caseId+': '+assessed.serviceComparison.verdict);
 }
 const summary={passed:true,mode:'REAL_JUDGE_REASSESSMENT_OF_SAVED_REAL_EXECUTIONS',source,model:model.upstreamModelId??modelId,verdicts:results.map(result=>({caseId:result.caseId,verdict:result.judge.serviceComparison.verdict})),output};await save('result.json',summary);console.log(JSON.stringify(summary));
}catch(error){await save('result.json',{passed:false,error:String(error),source,output});console.error(String(error));process.exitCode=1}
