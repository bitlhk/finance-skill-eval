import {beforeAll,expect,it} from 'vitest';
import path from 'node:path';
import {loadEvalPack} from '../src/eval-pack.js';
import {buildReport,renderHtmlReport,type EvaluationCaseReport} from '../src/report.js';
import {judgeResultSchema,runtimeExecutionEvidenceSchema,type EvalPack} from '../src/contracts.js';

let pack:EvalPack;
beforeAll(async()=>{pack=await loadEvalPack(path.resolve('packs/finance/investment-research/eval.yaml'))});
const assessment=(verdict:'PASS'|'FAIL'|'INDETERMINATE')=>({status:'assessed' as const,assessment:{verdict,reason:'<unsafe-reason>',checks:[{criterion:'goal',verdict,reason:'checked',evidence:'<unsafe-quote>'}]}});
function row(left: 'PASS'|'FAIL'|'INDETERMINATE'|'unavailable',right:'PASS'|'FAIL'|'INDETERMINATE'|'unavailable'):EvaluationCaseReport{
  const result=(status:typeof left)=>status==='unavailable'?{status:'unavailable' as const,error:'<unsafe-error>'}:assessment(status);
  const evidence=(side:'left'|'right')=>runtimeExecutionEvidenceSchema.parse({runId:'run',caseId:'case',side,status:(side==='left'?left:right)==='unavailable'?'failed':'completed',modelId:'model',skillVersion:'1',output:'answer',elapsedMs:1,runtimeIdentityVerified:true,streamCompleted:true,error:null});
  return {caseId:'case',name:'case',prompt:'task',evaluationGoal:'goal',left:evidence('left'),right:evidence('right'),judgeError:null,
    judge:judgeResultSchema.parse({runtimeComparison:{left:result(left),right:result(right)},confidence:'medium',summary:'Independent goals',dimensions:[],reviewerLabel:'judge'})};
}
function report(cases:EvaluationCaseReport[]){return buildReport({pack,reportId:'report',runtimeAdapterId:'two-runtimes',judgeId:'model-runtime-goals:test',cases})}

it('counts absolute outcomes on each side and never manufactures a tie',()=>{
  const value=report([row('PASS','FAIL'),row('FAIL','PASS'),row('INDETERMINATE','unavailable'),row('unavailable','INDETERMINATE')]);
  expect(value.summary).toMatchObject({leftWins:0,rightWins:0,ties:0,runtimeComparison:{left:{PASS:1,FAIL:1,INDETERMINATE:1,unavailable:1},right:{PASS:1,FAIL:1,INDETERMINATE:1,unavailable:1}}});
  expect(value.summary.headline).toContain('左侧 1/4');expect(value.summary.headline).toContain('右侧 1/4');expect(value.suggestions).toEqual([]);
  const html=renderHtmlReport(value);
  expect(html).toContain('双侧独立目标验收');expect(html).toContain('左侧 · FAIL');expect(html).toContain('右侧 · INDETERMINATE');
  expect(html).not.toMatch(/持平|胜出|更优/);
  for(const text of ['unsafe-reason','unsafe-quote','unsafe-error']){expect(html).toContain(`&lt;${text}&gt;`);expect(html).not.toContain(`<${text}>`)}
});
it('renders missing judgments and both runtime failures as unavailable, not a tie',()=>{
  const missing={...row('PASS','PASS'),judge:null,judgeError:'judge failed'};
  const value=report([missing,row('unavailable','unavailable')]);
  expect(value.summary.runtimeComparison?.left.unavailable).toBe(2);expect(value.summary.runtimeComparison?.right.unavailable).toBe(2);
  expect(renderHtmlReport(value)).not.toMatch(/持平|胜出|更优/);
  expect(renderHtmlReport(value)).toContain('左侧 不可用<b>2');
});
it('supports historical reports without judgeId and preserves genuine pairwise ties',()=>{
  const value=report([row('PASS','PASS')]);
  delete (value as any).judgeId;
  expect(renderHtmlReport(value)).toContain('双侧独立目标验收');
  value.cases[0]!.judge={winner:'tie',confidence:'medium',summary:'equal',dimensions:[],reviewerLabel:'legacy'};
  expect(renderHtmlReport(value)).toContain('表现持平');
});
it('does not treat a failed runtime as a quality PASS even in inconsistent stored data',()=>{
  const item=row('PASS','PASS');item.left.status='failed';
  const value=report([item]);expect(value.summary.runtimeComparison?.left).toMatchObject({PASS:0,unavailable:1});
  const html=renderHtmlReport(value);expect(html).toContain('左侧 · 不可用');expect(html).not.toContain('左侧 · PASS');
});
