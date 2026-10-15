import { expect,it,vi } from 'vitest';
import { CandidateAssessmentRuntimeAdapter } from '../src/candidate-assessment-runtime.js';
import type { RuntimeAdapter } from '../src/adapters.js';

it('executes the assessed candidate once and reuses its evidence without changing the report sides',async()=>{
  const execute=vi.fn<RuntimeAdapter['execute']>(async request=>({runId:request.runId,side:request.side,caseId:request.evalCase.caseId,status:'completed',modelId:request.model.modelId,
    skillVersion:request.variant.mode==='skill_version'?request.variant.version:null,output:'candidate result',elapsedMs:1,toolCalls:[],loadedSkills:[],usage:null,
    runtimeIdentityVerified:true,streamCompleted:true,error:null,traceFingerprint:'a'.repeat(64),metadata:{}}));
  const inner:RuntimeAdapter={adapterId:'fixture',execute},variant={mode:'skill_version' as const,skillId:'candidate',version:'2.0.0'},model={providerId:'fixture',modelId:'candidate-model'};
  const runtime=new CandidateAssessmentRuntimeAdapter(inner,variant,model),evalCase={caseId:'case',name:'case',taskMode:'single_turn' as const,prompt:'task',evaluationGoal:'goal',requiredTools:[],rubric:[],tags:[]};
  const common={runId:'run',evalCase,model:{providerId:'wrong',modelId:'wrong'},variant:{mode:'without_target_skill' as const,skillId:'candidate'}};
  const left=await runtime.execute({...common,side:'left'}),right=await runtime.execute({...common,side:'right'});
  expect(execute).toHaveBeenCalledOnce();expect(execute.mock.calls[0]?.[0]).toEqual(expect.objectContaining({side:'right',variant,model}));
  expect([left.side,right.side]).toEqual(['left','right']);expect(left.output).toBe(right.output);expect(left.metadata.candidateAssessmentReused).toBe(true);
});

it.each([false,true])('forwards finalization evidence after cleanup, including failure=%s',async failed=>{
  const receipt={status:failed?'FAILED':'RELEASED',scope:'LAUNCHER_MANAGED_RESOURCES'};
  const inner:RuntimeAdapter={adapterId:'fixture',execute:vi.fn(),cleanup:async()=>{if(failed)throw new Error('cleanup failed');},finalizationEvidence:()=>receipt};
  const runtime=new CandidateAssessmentRuntimeAdapter(inner,{mode:'without_target_skill',skillId:'candidate'},{providerId:'fixture',modelId:'model'});
  if(failed)await expect(runtime.cleanup()).rejects.toThrow('cleanup failed');else await runtime.cleanup();
  expect(runtime.finalizationEvidence()).toEqual(receipt);
});

it('does not manufacture a release receipt for an adapter without observations',()=>{
  const runtime=new CandidateAssessmentRuntimeAdapter({adapterId:'fixture',execute:vi.fn()},{mode:'without_target_skill',skillId:'candidate'},{providerId:'fixture',modelId:'model'});
  expect(runtime.finalizationEvidence()).toEqual({status:'UNKNOWN',reason:'NO_FINALIZATION_RECEIPT'});
});
