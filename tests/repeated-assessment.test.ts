import {expect,it,vi} from 'vitest';
import {assessmentStability,repeatAssessment} from '../src/evaluation/application/repeated-assessment.js';
import {ModelPairwiseJudge} from '../src/judge.js';
import {loadEvalPack} from '../src/eval-pack.js';
import {runtimeExecutionEvidenceSchema} from '../src/contracts.js';

it('counts missing and failed assessments in coverage without inventing agreement',()=>{
  expect(assessmentStability([[{caseId:'a',outcome:'PASS'}],[{caseId:'a',outcome:'FAIL'}],[],[{caseId:'a',outcome:null}]]))
    .toEqual([{caseId:'a',attempts:4,assessed:2,unavailable:2,counts:{PASS:1,FAIL:1},coverage:0.5,agreement:0.5}]);
  expect(assessmentStability([[{caseId:'a',outcome:null}]])[0]?.agreement).toBeNull();
});
it('bounds repetitions and stops before further judge calls on cancellation',async()=>{
  const controller=new AbortController();
  const assess=vi.fn(async()=>{controller.abort(new Error('cancel'));return 1;});
  await expect(repeatAssessment(3,assess,controller.signal)).rejects.toThrow('cancel');
  expect(assess).toHaveBeenCalledTimes(1);
  await expect(repeatAssessment(6,assess)).rejects.toThrow();
});
it('exchanges actual anonymous model inputs and maps votes back to original sides',async()=>{
  const pack=await loadEvalPack('packs/finance/investment-research/eval.yaml');
  const complete=vi.fn(async()=>({modelId:'judge',content:JSON.stringify({winner:'A',confidence:'high',summary:'A preferred',
    dimensions:pack.judgeProfile.dimensions.map(d=>({id:d.id,aScore:4,bScore:1,reason:'A preferred'}))})}));
  const judge=new ModelPairwiseJudge({adapterId:'fixture',complete},pack.models.judge);
  const evidence=runtimeExecutionEvidenceSchema.parse({runId:'r',caseId:pack.cases[0]!.caseId,side:'left',modelId:'test',skillVersion:null,
    status:'completed',output:'LEFT_ANSWER',elapsedMs:1,error:null,metadata:{},runtimeIdentityVerified:true,streamCompleted:true});
  const input={evalCase:pack.cases[0]!,left:evidence,right:{...evidence,side:'right' as const,output:'RIGHT_ANSWER'},profile:pack.judgeProfile};
  const normal=await judge.compare({...input,presentationOrder:'normal'});
  const swapped=await judge.compare({...input,presentationOrder:'swapped'});
  expect(normal.winner).toBe('left');expect(swapped.winner).toBe('right');
  const payloads=complete.mock.calls.map(call=>JSON.parse((call as any)[0].messages[1].content));
  expect(payloads.map(p=>p.outputA)).toEqual(['LEFT_ANSWER','RIGHT_ANSWER']);
  expect(input.left.output).toBe('LEFT_ANSWER');
});
