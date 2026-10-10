import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {MigrationAssessmentStep} from '../web/src/MigrationAssessmentStep.js';

it('does not let newer reuse jobs replace the selected business assessment or duplicate its history',()=>{
 const result=(caseId:string,verdict:string)=>({caseId,prompt:'Check',right:{status:'completed',output:'Result',toolCalls:[]},left:{status:'completed',output:'',toolCalls:[]},judge:{goalAssessment:{verdict,reason:'Evidence',checks:[]}}});
 const experiments=[{jobId:'business',candidateDigest:'digest',execution:'completed',createdAt:'2026-10-10T00:00:00Z',report:{cases:[result('business-case','PASS')]}},
  {jobId:'reuse',reuseAcceptanceTaskId:'reuse-task',candidateDigest:'digest',execution:'completed',createdAt:'2026-10-10T01:00:00Z',report:{cases:[result('reuse-only-case','INDETERMINATE')]}}];
 const html=renderToStaticMarkup(createElement(MigrationAssessmentStep,{
  api:async()=>null as never,projectId:'project',candidateDigest:'digest',suites:[],experiments:experiments as never,
  busy:false,refresh:async()=>{},runtimeId:'',setRuntimeId:()=>{},runtimes:[],modelKey:'',setModelKey:()=>{},packId:'',setPackId:()=>{},run:()=>{},next:()=>{},
 }));
 expect(html).toContain('最新 1/1 通过');expect(html).toContain('business-case');
 expect(html).not.toContain('reuse-only-case');expect(html).not.toContain('复用验收运行');
});
