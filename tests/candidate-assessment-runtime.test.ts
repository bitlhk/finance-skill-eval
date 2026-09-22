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
