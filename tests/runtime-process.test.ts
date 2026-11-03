import {describe,it,expect} from 'vitest';
import {runtimeExecutionEvidenceSchema} from '../src/contracts.js';
import {runtimeProcessSchema} from '../src/shared/contracts/runtime-process.js';
import {withRuntimeProcess,toolTraceStatus} from '../src/evaluation/domain/runtime-process.js';
import {evidenceResources,readEvidencePointer} from '../src/evaluation/domain/evidence-resources.js';
import {inspectRuntimeIntake} from '../src/evaluation/application/runtime-intake.js';
import {standardCapabilities} from './runtime-standard-fixture.js';
import {evalCaseSchema} from '../src/contracts.js';
import {evaluationPlanSchema} from '../src/evaluation/domain/evaluation-plan.js';
import {plannedMethods} from '../src/evaluation/application/planned-methods.js';
import {evaluateMethods} from '../src/evaluation/application/evaluation-method.js';
import {queryEvidence} from '../src/agents/evidence-query.js';

const process={schemaVersion:'finance.runtime-process.v1',status:'COMPLETE',scopes:['tools'],records:[
  {id:'r1',kind:'tool',callId:'c1',name:'lookup',status:'completed',input:{id:'123'},output:{amount:100}},
]};
const evidence=(value:unknown=process)=>runtimeExecutionEvidenceSchema.parse({runId:'r',caseId:'c',side:'right',modelId:'m',skillVersion:null,
  status:'completed',output:'100',elapsedMs:1,runtimeIdentityVerified:true,streamCompleted:true,error:null,metadata:{process:value}});
describe('shared execution process evidence',()=>{
  it('reports tool completeness consistently and never upgrades partial process from legacy telemetry',()=>{
    expect(toolTraceStatus(evidence())).toBe('COMPLETE');
    expect(toolTraceStatus(evidence({...process,scopes:['events'],records:[]}))).toBe('PARTIAL_OR_UNAVAILABLE');
    const partial=evidence({...process,status:'PARTIAL',reason:'Some calls omitted'});
    partial.metadata.telemetry={status:'COMPLETE'};
    expect(toolTraceStatus(partial)).toBe('PARTIAL_OR_UNAVAILABLE');
    const old=evidence();delete old.metadata.process;old.metadata.telemetry={status:'COMPLETE'};
    expect(toolTraceStatus(old)).toBe('COMPLETE');
    expect(toolTraceStatus()).toBe('PARTIAL_OR_UNAVAILABLE');
  });
  it('uses saved process records for rules, scripts and Agent queries',async()=>{
    const saved=JSON.parse(JSON.stringify(withRuntimeProcess(evidence(),true)));
    const plan=evaluationPlanSchema.parse({version:'1',checks:[
      {id:'amount',version:'1',kind:'RULE',rule:{operation:'equals',reference:'/process/records/0/output/amount',expected:100}},
      {id:'script',version:'1',kind:'SCRIPT',script:'verify()',evidenceRefs:['/process/records/0/output']},
    ]});
    const evalCase=evalCaseSchema.parse({caseId:'c',name:'case',prompt:'lookup',evaluationGoal:'amount',
      rubric:[{criterionId:'amount',label:'amount',description:'correct',dimension:'business_completeness',weight:1}]});
    let invocations=0;
    const methods=plannedMethods(plan,async(_script,resources)=>{
      invocations++;
      expect(queryEvidence(resources,{path:'/process/records/0/output'})).toMatchObject({available:true,content:'{"amount":100}'});
      return {checks:[{id:'receipt',status:'PASS',reason:'Observed amount',evidenceRefs:['/process/records/0/output/amount']}]};
    });
    expect((await evaluateMethods({evalCase,evidence:saved},methods)).map(r=>r.status)).toEqual(['PASS','PASS']);
    const unavailable=withRuntimeProcess(evidence({schemaVersion:'finance.runtime-process.v1',status:'UNAVAILABLE',scopes:[],records:[],reason:'No hooks'}));
    expect((await evaluateMethods({evalCase,evidence:unavailable},methods)).map(r=>r.status)).toEqual(['UNVERIFIED','UNVERIFIED']);
    expect(invocations).toBe(1);
  });
  it('projects real returned values into existing tools and exposes citations to judges',()=>{
    const result=withRuntimeProcess(evidence(),true);
    expect(result.toolCalls).toEqual([{name:'lookup',status:'completed'}]);
    expect(result.metadata.toolEvidence).toMatchObject([{tool:'lookup',arguments:{id:'123'},result:{amount:100}}]);
    expect(readEvidencePointer(evidenceResources(result),'/process/records/0/output/amount')).toBe(100);
    expect(withRuntimeProcess(result)).toEqual(result);
  });
  it('keeps unavailable/partial records truthful and does not fabricate missing outputs',()=>{
    const partial={...process,status:'PARTIAL',reason:'Timeout',records:[{...process.records[0],status:'incomplete'}]};
    expect(withRuntimeProcess(evidence(partial)).toolCalls).toEqual([]);
    expect(()=>runtimeProcessSchema.parse({...partial,status:'COMPLETE'})).toThrow();
    expect(()=>runtimeProcessSchema.parse({...partial,reason:undefined})).toThrow();
    const missing=evidence({...process,status:'UNAVAILABLE',scopes:[],records:[],reason:'No hooks'});
    expect(withRuntimeProcess(missing,true).metadata.process).toMatchObject({status:'UNAVAILABLE'});
  });
  it('rejects duplicate calls, oversized data and conflicting complete summaries',()=>{
    expect(()=>runtimeProcessSchema.parse({...process,records:[process.records[0],{...process.records[0],id:'r2'}]})).toThrow();
    expect(()=>runtimeProcessSchema.parse({...process,records:[{...process.records[0],output:'x'.repeat(140000)}]})).toThrow();
    expect(()=>withRuntimeProcess({...evidence(),toolCalls:[{name:'other',status:'completed'}]},true)).toThrow('do not match');
  });
  it('requires the new contract on intake but keeps historical reports readable',()=>{
    const old=evidence();delete old.metadata.process;
    expect(withRuntimeProcess(old)).toEqual(old);
    expect(()=>withRuntimeProcess(old,true)).toThrow('metadata.process');
    expect(inspectRuntimeIntake({capabilities:standardCapabilities(),evidence:old,identity:{runId:'r',caseId:'c',side:'right'}}).issues).toContain('execution.process-invalid');
  });
});
