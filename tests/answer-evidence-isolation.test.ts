import {expect,it,vi} from 'vitest';
import {evalCaseSchema,runtimeExecutionEvidenceSchema} from '../src/contracts.js';
import {answerEvidence} from '../src/evaluation/domain/answer-evidence.js';
import {createCriterionJudge} from '../src/agents/criterion-judge.js';

const evalCase=evalCaseSchema.parse({caseId:'booking',name:'Booking',prompt:'Book a room',evaluationGoal:'Correct booking',
  rubric:[{criterionId:'quality',scope:'answer',label:'Quality',description:'Explain result clearly',dimension:'clarity',weight:1},
    {criterionId:'booking',scope:'execution',label:'Booking',description:'Booking actually succeeded',dimension:'business_completeness',weight:1}],
  evaluationPlan:{version:'1',checks:[],answerEvidence:[{id:'bookingStatus',reference:'/toolEvidence/0/result/status'}]}});
const evidence=runtimeExecutionEvidenceSchema.parse({runId:'run',caseId:'booking',side:'right',status:'completed',modelId:'PRIVATE_MODEL',
  skillVersion:'PRIVATE_VERSION',output:'Booking succeeded',elapsedMs:1,runtimeIdentityVerified:true,streamCompleted:true,error:null,
  loadedSkills:[{skillId:'PRIVATE_SKILL',version:'v1'}],toolCalls:[{name:'PRIVATE_TOOL',status:'failed'}],
  metadata:{toolEvidence:[{tool:'PRIVATE_TOOL',status:'failed',result:{status:'failed',internalPath:'PRIVATE_PATH'}}]}});
it('projects only explicit scalar fields and preserves unavailable provenance',()=>{
  expect(answerEvidence(evalCase,evidence).materials).toEqual({output:'Booking succeeded',businessFacts:{bookingStatus:null}});
  const completed=structuredClone(evidence);(completed.metadata.toolEvidence as any[])[0].status='completed';
  expect(answerEvidence(evalCase,completed).materials.businessFacts).toEqual({bookingStatus:'failed'});
  expect(JSON.stringify(answerEvidence(evalCase,completed).materials)).not.toContain('PRIVATE');
  (completed.metadata.toolEvidence as any[])[0].result.status={hidden:'PRIVATE'};
  expect(answerEvidence(evalCase,completed).materials.businessFacts.bookingStatus).toBeNull();
  (completed.metadata.toolEvidence as any[])[0].result=JSON.stringify({status:'booked',secret:'PRIVATE'});
  expect(answerEvidence(evalCase,completed).materials.businessFacts).toEqual({bookingStatus:'booked'});
});
it('rejects whole-result and trace projections at the plan boundary',()=>{
  for(const reference of ['/toolEvidence/0/result','/telemetry/status','/toolCalls/0/name']){
    expect(evalCaseSchema.safeParse({...evalCase,evaluationPlan:{version:'1',checks:[],answerEvidence:[{id:'fact',reference}]}}).success).toBe(false);
  }
});
it('separates actual model requests and blocks query escape; quality cannot override failed booking',async()=>{
  const complete=vi.fn().mockResolvedValueOnce({modelId:'judge',content:JSON.stringify({evidenceQuery:{path:'/toolCalls',offset:0,limit:100}})})
    .mockResolvedValueOnce({modelId:'judge',content:JSON.stringify({criteria:[{id:'quality',passed:true,reason:'Clear answer',evidenceRefs:['/output']}]})})
    .mockResolvedValueOnce({modelId:'judge',content:JSON.stringify({criteria:[{id:'booking',passed:false,reason:'Booking failed',evidenceRefs:['/toolCalls/0/status']}]})});
  const judge=createCriterionJudge({adapter:{adapterId:'test',complete},model:{providerId:'test',modelId:'judge',parameters:{}}});
  const result=await judge({evalCase,evidence},{requestId:'separation'});
  expect(result.passed).toBe(false);
  expect(result.criteria?.map(c=>[c.scope,c.passed])).toEqual([['answer',true],['execution',false]]);
  const qualityRequests=JSON.stringify(complete.mock.calls.slice(0,2));
  for(const marker of ['PRIVATE_TOOL','PRIVATE_SKILL','PRIVATE_MODEL','PRIVATE_PATH'])expect(qualityRequests).not.toContain(marker);
  expect(JSON.stringify(complete.mock.calls[2])).toContain('PRIVATE_TOOL');
  expect(result.assessmentVersion).toBe('separated-assessment-v1');
});
