import {expect,it,vi} from 'vitest';
import {runOptimizationLoop,type OptimizationLoopPorts} from '../src/improvement/application/optimization-loop.js';
import {optimizationGoalSchema,type OptimizationLoop,type OptimizationEvaluation} from '../src/improvement/domain/optimization-loop.js';
import {effectReviewInput} from '../src/improvement/application/review-input.js';
import type {EffectReviewResult} from '../src/agents/ports.js';
const ref=(id:string)=>({id,digest:id});
const evaluation=(id:string,passes:boolean[],protocolDigest='same'):OptimizationEvaluation=>({id,candidate:ref(id),protocolDigest,
  cases:passes.map((passed,index)=>({id:`case-${index}`,passed,observation:{passed}}))});
function fixture(maxRounds=2){
  const baseline=evaluation('base',[true,false]);
  const state:OptimizationLoop={id:'loop',goal:optimizationGoalSchema.parse({maxRounds}),baseline:ref('base'),best:ref('base'),bestEvaluationId:'base',
    status:'RUNNING',stage:'DIAGNOSIS',rounds:[],createdAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+60000).toISOString()};
  const ports:OptimizationLoopPorts={
    diagnose:vi.fn(async()=>({status:'PROPOSED',hypothesis:{layer:'SKILL',issue:'Missing constraint',expectedBehavior:'Follow it',evidenceCaseIds:['case-1'],validation:'Retest',risk:'Low',confidence:'HIGH'}})),
    adjust:vi.fn(async()=>ref('new')),evaluate:vi.fn(async()=>evaluation('new',[true,true])),
    review:vi.fn(async()=>({status:'PRODUCED',review:{recommendation:'KEEP_CANDIDATE',reason:'Verified',improvements:['New case passes'],regressions:[],evidenceIds:['case-1']}})),save:vi.fn(async()=>{}),
  };
  return {baseline,state,ports};
}
it('diagnoses again after a rejected experiment, then stops at the goal with an independently reviewed candidate',async()=>{
  const f=fixture(3);vi.mocked(f.ports.review).mockResolvedValueOnce({status:'ABSTAINED',reason:'Insufficient activation evidence'});
  await runOptimizationLoop(f.state,f.baseline,f.ports,new AbortController().signal);
  expect(f.state.status).toBe('REVIEW');expect(f.state.rounds).toHaveLength(2);expect(f.state.targetReached).toBe(true);
  expect(f.ports.diagnose).toHaveBeenCalledTimes(2);
  expect(vi.mocked(f.ports.diagnose).mock.calls[1]![1][0]?.review).toMatchObject({status:'ABSTAINED'});
  expect(f.state.rounds.map(r=>r.selected)).toEqual([false,true]);
});
it('requires an explained tradeoff before following a positive Review with regressions',async()=>{
  const f=fixture(2);vi.mocked(f.ports.evaluate).mockResolvedValue(evaluation('new',[false,true]));
  await runOptimizationLoop(f.state,f.baseline,f.ports,new AbortController().signal);
  expect(f.state.status).toBe('STOPPED');expect(f.state.best).toEqual(ref('base'));expect(f.ports.adjust).toHaveBeenCalledTimes(2);
  expect(f.state.rounds[0]?.reason).toContain('取舍');
});
const tradeoffReview=(recommendation:'KEEP_CANDIDATE'|'CONTINUE_CANDIDATE'):EffectReviewResult=>({status:'PRODUCED',review:{
  recommendation,reason:'Core workflow improves; repair the less frequent edge case next',improvements:['Core workflow passes'],
  regressions:['case-0 fails'],evidenceIds:['case-0','case-1'],tradeoff:'The core workflow matters more to the declared goal',nextFocus:['Repair case-0 without losing the new capability'],
}});
it('can recommend overall improvement with an explained ordinary regression',async()=>{
  const f=fixture(1);f.baseline=evaluation('base',[true,false,false]);
  vi.mocked(f.ports.evaluate).mockResolvedValue(evaluation('new',[false,true,true]));
  vi.mocked(f.ports.review).mockResolvedValue(tradeoffReview('KEEP_CANDIDATE'));
  await runOptimizationLoop(f.state,f.baseline,f.ports,new AbortController().signal);
  expect(f.state).toMatchObject({status:'REVIEW',best:ref('new'),working:ref('new'),targetReached:false});
  expect(f.state.rounds[0]).toMatchObject({selected:true,continued:false,regressedCaseIds:['case-0']});
});
it('diagnoses and edits the exploratory version, then reviews against both parent and incumbent',async()=>{
  const f=fixture(2),trial=evaluation('trial',[false,true]),fixed=evaluation('fixed',[true,true]);
  vi.mocked(f.ports.adjust).mockResolvedValueOnce(ref('trial')).mockResolvedValueOnce(ref('fixed'));
  vi.mocked(f.ports.evaluate).mockResolvedValueOnce(trial).mockResolvedValueOnce(fixed);
  vi.mocked(f.ports.review).mockResolvedValueOnce(tradeoffReview('CONTINUE_CANDIDATE'));
  await runOptimizationLoop(f.state,f.baseline,f.ports,new AbortController().signal);
  expect(vi.mocked(f.ports.diagnose).mock.calls[1]![0]).toEqual(trial);
  expect(vi.mocked(f.ports.adjust).mock.calls[1]![0]).toEqual(ref('trial'));
  const secondReview=vi.mocked(f.ports.review).mock.calls[1]!;
  expect(secondReview[0]).toEqual(trial);expect(secondReview[4]).toEqual(f.baseline);
  const input=effectReviewInput(f.state.goal.goal,trial,fixed,[],{incumbent:f.baseline});
  expect(input.incumbentDigest).toBe('base');
  expect(JSON.parse(input.evidence[0]!.summary)).toEqual({before:false,after:true,incumbent:true});
  expect(f.state.rounds.map(r=>[r.selected,r.continued])).toEqual([[false,true],[true,false]]);
  expect(f.state).toMatchObject({best:ref('fixed'),working:ref('fixed'),targetReached:true,status:'REVIEW'});
});
it('does not promote an exploratory version when the budget ends, even if its pass rate reaches the target',async()=>{
  const f=fixture(1);f.state.goal.targetPassRate=.5;
  vi.mocked(f.ports.evaluate).mockResolvedValue(evaluation('new',[false,true]));
  vi.mocked(f.ports.review).mockResolvedValue(tradeoffReview('CONTINUE_CANDIDATE'));
  await runOptimizationLoop(f.state,f.baseline,f.ports,new AbortController().signal);
  expect(f.state).toMatchObject({best:ref('base'),working:ref('new'),workingEvaluationId:'new',status:'STOPPED',targetReached:false});
  expect(f.state.reason).toContain('实验版本');
});
it('returns to the incumbent after an exploratory branch is rejected',async()=>{
  const f=fixture(3);
  vi.mocked(f.ports.adjust).mockResolvedValueOnce(ref('trial')).mockResolvedValueOnce(ref('worse')).mockResolvedValueOnce(ref('fixed'));
  vi.mocked(f.ports.evaluate).mockResolvedValueOnce(evaluation('trial',[false,true])).mockResolvedValueOnce(evaluation('worse',[false,false])).mockResolvedValueOnce(evaluation('fixed',[true,true]));
  vi.mocked(f.ports.review).mockResolvedValueOnce(tradeoffReview('CONTINUE_CANDIDATE')).mockResolvedValueOnce({status:'ABSTAINED',reason:'No reliable benefit'});
  await runOptimizationLoop(f.state,f.baseline,f.ports,new AbortController().signal);
  expect(vi.mocked(f.ports.adjust).mock.calls.map(call=>call[0].id)).toEqual(['base','trial','base']);
  expect(f.state.best.id).toBe('fixed');
});
it.each(['KEEP_CANDIDATE','CONTINUE_CANDIDATE'] as const)('keeps explicit must-pass constraints when Review says %s',async recommendation=>{
  const f=fixture(1);f.state.goal.protectedCaseIds=['case-0'];
  vi.mocked(f.ports.evaluate).mockResolvedValue(evaluation('new',[false,true]));
  vi.mocked(f.ports.review).mockResolvedValue(tradeoffReview(recommendation));
  await runOptimizationLoop(f.state,f.baseline,f.ports,new AbortController().signal);
  expect(f.state.best).toEqual(ref('base'));expect(f.state.working).toEqual(ref('base'));
  expect(f.state.rounds[0]?.reason).toContain('必须通过');
});
it('rejects unknown must-pass case IDs before calling any agent',async()=>{
  const f=fixture();f.state.goal.protectedCaseIds=['holdout-case'];
  await runOptimizationLoop(f.state,f.baseline,f.ports,new AbortController().signal);
  expect(f.state.status).toBe('FAILED');expect(f.ports.diagnose).not.toHaveBeenCalled();
});
it('does not continue an experimental candidate without a repair direction',async()=>{
  const f=fixture(1),review=tradeoffReview('CONTINUE_CANDIDATE');
  if(review.status==='PRODUCED')delete review.review.nextFocus;
  vi.mocked(f.ports.review).mockResolvedValue(review);
  await runOptimizationLoop(f.state,f.baseline,f.ports,new AbortController().signal);
  expect(f.state.best).toEqual(ref('base'));expect(f.state.rounds[0]?.reason).toContain('修复方向');
});
it('does not send incomplete or differently configured evaluation to Review',async()=>{
  const f=fixture();vi.mocked(f.ports.evaluate).mockResolvedValue(evaluation('new',[true,true],'changed'));
  await runOptimizationLoop(f.state,f.baseline,f.ports,new AbortController().signal);
  expect(f.state.status).toBe('FAILED');expect(f.ports.review).not.toHaveBeenCalled();expect(f.state.best).toEqual(ref('base'));
});

it('rejects an evaluation receipt for a different candidate before Review',async()=>{
  const f=fixture();vi.mocked(f.ports.evaluate).mockResolvedValue(evaluation('cached-old-version',[true,true]));
  await runOptimizationLoop(f.state,f.baseline,f.ports,new AbortController().signal);
  expect(f.state.status).toBe('FAILED');expect(f.state.reason).toContain('不属于本轮候选');
  expect(f.ports.review).not.toHaveBeenCalled();expect(f.state.best).toEqual(ref('base'));
});
it('stops before launching work when cancelled and records the reason',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort(new Error('Stop'));
  await runOptimizationLoop(f.state,f.baseline,f.ports,controller.signal);
  expect(f.state.status).toBe('CANCELLED');expect(f.ports.diagnose).not.toHaveBeenCalled();expect(f.ports.save).toHaveBeenCalled();
});
it('does not review or evaluate a candidate with no effective change',async()=>{
  const f=fixture(1);vi.mocked(f.ports.adjust).mockResolvedValue(ref('base'));
  await runOptimizationLoop(f.state,f.baseline,f.ports,new AbortController().signal);
  expect(f.state.status).toBe('STOPPED');expect(f.ports.evaluate).not.toHaveBeenCalled();
});

it('waits without ending the task and resumes the same round after an authorized Runtime change',async()=>{
  const f=fixture(1);f.baseline.criteriaDigest='frozen-criteria';
  vi.mocked(f.ports.adjust).mockResolvedValue({status:'WAITING',kind:'BUILDER',candidate:ref('base'),reason:'Rebuild the execution loop'});
  await runOptimizationLoop(f.state,f.baseline,f.ports,new AbortController().signal);
  expect(f.state.status).toBe('WAITING');expect(f.state.finishedAt).toBeUndefined();expect(f.ports.evaluate).not.toHaveBeenCalled();
  expect(f.state.waiting?.remainingMs).toBeGreaterThan(0);
  const stored=structuredClone(f.state),upgraded={...evaluation('base',[true,true],'new-runtime'),id:'rebuilt-evaluation',criteriaDigest:'frozen-criteria'};
  stored.status='RUNNING';stored.deadlineAt=new Date(Date.now()+stored.waiting!.remainingMs).toISOString();
  vi.mocked(f.ports.evaluate).mockResolvedValue(upgraded);
  await runOptimizationLoop(stored,f.baseline,f.ports,new AbortController().signal,{working:f.baseline,incumbent:f.baseline,candidate:ref('base'),contextChange:{reference:'build-2',reason:'Runtime rebuilt'}});
  expect(stored.status).toBe('REVIEW');expect(stored.rounds).toHaveLength(1);expect(f.ports.diagnose).toHaveBeenCalledTimes(1);expect(f.ports.adjust).toHaveBeenCalledTimes(1);
  expect(stored.bestEvaluationId).toBe('rebuilt-evaluation');expect(stored.contextChanges?.[0]?.reference).toBe('build-2');
});

it('does not authorize changed evaluation criteria through a Builder resume',async()=>{
  const f=fixture(1);f.baseline.criteriaDigest='frozen';
  vi.mocked(f.ports.adjust).mockResolvedValue({status:'WAITING',kind:'BUILDER',candidate:ref('new'),reason:'Rebuild'});
  await runOptimizationLoop(f.state,f.baseline,f.ports,new AbortController().signal);
  f.state.status='RUNNING';vi.mocked(f.ports.evaluate).mockResolvedValue({...evaluation('new',[true,true],'different'),criteriaDigest:'changed'});
  await runOptimizationLoop(f.state,f.baseline,f.ports,new AbortController().signal,{working:f.baseline,incumbent:f.baseline,candidate:ref('new'),contextChange:{reference:'build',reason:'Rebuild'}});
  expect(f.state.status).toBe('FAILED');expect(f.ports.review).not.toHaveBeenCalled();
});
