import {expect,it,vi} from 'vitest';
import {executeWithCaseState,type CaseStatePort} from '../src/evaluation/application/case-state-lifecycle.js';
import {executeEvaluationCase} from '../src/evaluation/application/execute-case.js';
import {canonicalSha256} from '../src/shared/json-canonicalization.js';
import {evalCaseSchema,runtimeExecutionEvidenceSchema} from '../src/contracts.js';
import type {RuntimeExecutionRequest} from '../src/adapters.js';
import {simpleMigrationSuiteSchema} from '../src/migration/domain/simple-migration-suite.js';
import {executionStatistics} from '../src/evaluation/domain/execution-statistics.js';
const initial={bookings:0},fixture={fixtureId:'booking-test',version:'1',initialStateDigest:canonicalSha256(initial)};
const request:RuntimeExecutionRequest={runId:'run',side:'right',model:{providerId:'test',modelId:'test',parameters:{}},variant:{mode:'without_target_skill',skillId:'s'},
  evalCase:evalCaseSchema.parse({caseId:'case',name:'case',prompt:'Book',evaluationGoal:'Booked',stateFixture:fixture,
    rubric:[{criterionId:'one',label:'one',description:'Booked',weight:1,dimension:'business_completeness'}]})};
const evidence=runtimeExecutionEvidenceSchema.parse({runId:'run',side:'right',caseId:'case',status:'completed',modelId:'test',skillVersion:null,
  output:'Booked',elapsedMs:1,runtimeIdentityVerified:true,streamCompleted:true,error:null,metadata:{}});
function environment(){
  let state={...initial};const phases:string[]=[];
  const port:CaseStatePort=async input=>{phases.push(input.phase);if(input.phase!=='capture')state={...initial};
    return {...input,status:'SUCCEEDED',state:{...state},stateDigest:canonicalSha256(state)};};
  return {port,phases,book:()=>{state.bookings++;},state:()=>state};
}
it('captures actual final state and restores the original before the next business attempt',async()=>{
  const env=environment();
  const execute=async()=>{env.book();return structuredClone(evidence);};
  for(let n=0;n<2;n++){
    const result=await executeWithCaseState(request,env.port,execute);
    expect(result.metadata.state).toEqual({bookings:1});expect(result.metadata.caseState).toMatchObject({status:'COMPLETE'});
    expect(env.state()).toEqual(initial);
  }
  expect(env.phases).toEqual(['prepare','capture','restore','prepare','capture','restore']);
});
it.each(['failure','cancellation'])('restores business state after %s without replaying business',async mode=>{
  const env=environment(),controller=new AbortController(),saved=vi.fn();
  const execute=vi.fn(async()=>{env.book();if(mode==='cancellation')controller.abort();throw Error('business interrupted');});
  await expect(executeWithCaseState({...request,signal:controller.signal},env.port,execute,saved)).rejects.toThrow('interrupted');
  expect(execute).toHaveBeenCalledTimes(1);expect(env.state()).toEqual(initial);
  expect(saved.mock.calls[0]?.[0]).toMatchObject({status:'COMPLETE'});
});
it('does not execute after an incorrect initial-state receipt and still attempts restoration',async()=>{
  const env=environment(),execute=vi.fn();
  const port:CaseStatePort=async(input,signal)=>({...await env.port(input,signal) as object,...(input.phase==='prepare'?{stateDigest:'a'.repeat(64)}:{})});
  await expect(executeWithCaseState(request,port,execute)).rejects.toThrow('digest mismatch');
  expect(execute).not.toHaveBeenCalled();expect(env.phases).toContain('restore');
});
it('retains business output but marks a failed restore incomplete',async()=>{
  const env=environment();
  const port:CaseStatePort=(input,signal)=>input.phase==='restore'?Promise.reject(Error('restore offline')):env.port(input,signal);
  const result=await executeWithCaseState(request,port,async()=>{env.book();return structuredClone(evidence);});
  expect(result.output).toBe('Booked');expect(result.metadata.caseState).toMatchObject({status:'INCOMPLETE',errors:[{phase:'restore'}]});
});
it('does not accept a custom runtime complete claim without correlated receipts',async()=>{
  const result=await executeEvaluationCase({request,failureMode:'evidence',runtime:{adapterId:'custom',supportsCaseState:()=>true,execute:async()=>({...evidence,metadata:{caseState:{status:'COMPLETE'},state:{bookings:1}}})}});
  expect(result.metadata.caseState).toMatchObject({status:'INCOMPLETE'});expect(result.metadata.state).toBeNull();
});
it('rejects an unsupported stateful case before invoking any business tool',async()=>{
  const execute=vi.fn(async()=>evidence);
  const result=await executeEvaluationCase({request,failureMode:'evidence',runtime:{adapterId:'legacy',execute}});
  expect(execute).not.toHaveBeenCalled();expect(result.metadata.executionDisposition).toBe('NOT_EXECUTED');
});
it('requires explicit repeat safety and counts missing attempts in statistics',()=>{
  const suite={name:'test',executionRepetitions:3,cases:[{id:'a',input:'Book',criteria:['Booked']}]};
  expect(simpleMigrationSuiteSchema.safeParse(suite).success).toBe(false);
  expect(simpleMigrationSuiteSchema.safeParse({...suite,cases:[{...suite.cases[0],stateFixture:fixture}]}).success).toBe(true);
  expect(executionStatistics(3,['a'],[[{id:'a',passed:true}],[{id:'a',passed:false}]])[0]).toMatchObject({passed:1,failed:1,unverified:1,successRate:1/3,allPassed:false});
});
