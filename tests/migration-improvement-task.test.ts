import {expect,it,vi} from 'vitest';
import {MigrationImprovementTaskService} from '../src/migration/application/migration-improvement-task-service.js';
import {executionConfigurationDigest} from '../src/execution-configuration/execution-configuration.js';
import {currentReuseProposal,reuseInputDigest} from '../src/migration/domain/migration-reuse-design.js';
import {KeyedQueue} from '../src/shared/keyed-queue.js';
import type {MigrationProject} from '../src/migration/domain/migration-project.js';
import type {EvaluationJob} from '../src/shared/contracts/evaluation-job.js';
import type {SkillAssetRecord} from '../src/shared/contracts/skill-asset.js';

function setup(options:{layer?:string;layers?:string[];devIds?:string[];roundPasses?:string[][];baselinePasses?:string[];finalPass?:boolean}={}){
  const base={assetId:'original',skillId:'test',version:'1',artifactSha256:'a'.repeat(64),skillFile:'SKILL.md'} as SkillAssetRecord;
  const trial={...base,assetId:'trial',version:'2',artifactSha256:'b'.repeat(64)};
  const config={revision:0,values:{},checks:[]};
  const definition=(caseId:string)=>({caseId,prompt:caseId==='holdout'?'HOLDOUT_PRIVATE':'task',requiredTools:[],rubric:[]});
  const devIds=options.devIds??['dev1','dev2'];
  const suite={packFingerprint:'frozen-pack',cases:devIds.map(definition),holdoutCases:[definition('holdout')]};
  const plan={pair:'BC',configuration:{evaluationMode:'candidate_assessment',selectedCaseIds:[],includeHoldout:false,
    runtime:{type:'runtime_launcher',environmentId:'launcher'},runtimeBindings:{left:{environmentId:'launcher',skillAssetId:base.assetId},right:{environmentId:'launcher',skillAssetId:base.assetId}}}};
  let project={id:'migration-1234',source:base,candidate:base,inspection:{tools:[{toolId:'tool'}]},
    candidateHistory:[],technicalValidations:[],runs:[{jobId:'baseline',pair:'BC',candidateDigest:base.artifactSha256,
      declaredPlan:plan,suiteSnapshot:suite,packFingerprint:suite.packFingerprint,solutionRevisions:{right:{revisionId:'revision'}},runtimeConfigurationDigest:executionConfigurationDigest(config)}]} as unknown as MigrationProject;
  const queue=new KeyedQueue();
  const jobs=new Map<string,EvaluationJob>();
  function job(id:string,asset:SkillAssetRecord,ids:string[],passes:string[]):EvaluationJob{
    return {jobId:id,status:'completed',configuration:{rightVariant:{mode:'skill_version',artifactSha256:asset.artifactSha256}},report:{cases:ids.map(caseId=>({caseId,
      right:{status:'completed',streamCompleted:true,runtimeIdentityVerified:true,toolCalls:[],output:'answer',metadata:{skillArtifactSha256:asset.artifactSha256}},
      judge:{goalAssessment:{verdict:passes.includes(caseId)?'PASS':'FAIL',reason:'observed'},summary:'review'}}))}} as unknown as EvaluationJob;
  }
  jobs.set('baseline',job('baseline',base,devIds,options.baselinePasses??['dev1']));
  let iteration=0;
  const d={projects:{runExclusive:<T>(key:string,fn:()=>Promise<T>)=>queue.run(key,fn),get:async()=>structuredClone(project),
    save:async(value:MigrationProject)=>{project=structuredClone(value)}},
    jobs:{get:(id:string)=>jobs.get(id)??null},runs:{cancel:vi.fn()},configs:{get:async()=>config},
    planner:{propose:vi.fn(async(_id:string,input:unknown,asset:SkillAssetRecord)=>{
      expect(JSON.stringify(input)).not.toContain('HOLDOUT_PRIVATE');
      return {planId:`plan-${++iteration}`,status:'PROPOSED',hypothesis:{layer:options.layers?.[iteration-1]??options.layer??'TOOL'}};
    })},tools:{propose:vi.fn(async()=>({attemptId:'attempt',candidate:trial,changedPaths:[],summary:'repair',validations:[{toolId:'tool',status:'PASSED'}]}))},
    technical:{currentState:vi.fn(async()=>({ready:true})),validateIsolated:vi.fn(async()=>({toolId:'tool',status:'PASSED'}))},
    execution:{validateExperiment:vi.fn(async(_id:string,input:any,experiment:any)=>{
      expect(project.candidate?.assetId).toBe('original');
      expect(experiment.expectedPackFingerprint).toBe('frozen-pack');
      const final=!!experiment.finalVerification;
      const ids=final?[...devIds,'holdout']:devIds;
      const passes=final?(options.finalPass===false?['dev1','dev2']:ids):(options.roundPasses?.[iteration-1]??ids);
      const value=job(`run-${jobs.size}`,experiment.candidate,ids,passes);
      jobs.set(value.jobId,value);return {job:value};
    })},
    optimizers:{propose:vi.fn(async()=>({optimizationId:'opt-1',status:'review',candidate:trial,changes:[],summary:'repair'})),decide:vi.fn()},
    skills:{readArchive:async()=>({})},candidateInspection:{inspect:vi.fn(async()=>({assetId:trial.assetId,assetDigest:trial.artifactSha256,tools:[{toolId:'tool'}]}))},
  };
  const service=new MigrationImprovementTaskService(d as unknown as ConstructorParameters<typeof MigrationImprovementTaskService>[0]);
  const terminal=async()=>{await vi.waitFor(()=>expect(project.improvementTasks?.at(-1)?.status).not.toBe('RUNNING'),{interval:10,timeout:4000});return project.improvementTasks!.at(-1)!;};
  return {service,d,base,trial,jobs,config,project:()=>project,terminal};
}

it('runs an isolated Tool candidate, checks frozen holdout once, and requires explicit adoption',async()=>{
  const f=setup();await f.service.start('migration-1234',{jobId:'baseline'});
  const task=await f.terminal();
  expect(task.status).toBe('REVIEW');expect(task.finalVerified).toBe(true);
  expect(task.iterations[0]?.outcome).toBe('PROMOTED');expect(f.project().candidate?.assetId).toBe('original');
  expect(f.d.execution.validateExperiment).toHaveBeenCalledTimes(2);
  expect(task.events.map(e=>e.sequence)).toEqual(task.events.map((_,i)=>i+1));
  await f.service.adopt('migration-1234',task.taskId);
  expect(f.project().candidate?.assetId).toBe('trial');expect(f.project().improvementTasks?.at(-1)?.status).toBe('ADOPTED');
});

it('rejects completed task adoption after its approved reuse proposal is no longer current',async()=>{
  const f=setup();await f.service.start('migration-1234',{jobId:'baseline'});
  expect((await f.terminal()).status).toBe('REVIEW');
  f.project().improvementTasks!.at(-1)!.reuseProposalId='previous-approved-proposal';
  await expect(f.service.adopt('migration-1234',f.project().improvementTasks!.at(-1)!.taskId)).rejects.toThrow('迁移方案已变化');
  expect(f.project().candidate?.assetId).toBe('original');
});

it('preserves approved choices and proposal after adopting an unchanged passing baseline',async()=>{
  const f=setup({baselinePasses:['dev1','dev2']}),project=f.project();
  project.sourceInspection={...project.inspection!,assetId:f.base.assetId,assetDigest:f.base.artifactSha256};
  project.decisions=[{toolId:'tool',baseAssetId:f.base.assetId,form:'MCP',language:'python',reason:'choice',decidedAt:'2026-10-08T00:00:00Z'}];
  const choices=structuredClone(project.decisions);
  project.reuseProposal={proposalId:'approved',sourceDigest:f.base.artifactSha256,
    inputDigest:reuseInputDigest(project.sourceInspection,choices,f.base.artifactSha256),
    approvedAt:'2026-10-08T00:00:00Z'} as MigrationProject['reuseProposal'];
  project.candidateReuseProposalId='approved';project.runs[0]!.reuseProposalId='approved';
  await f.service.start(project.id,{jobId:'baseline'});const task=await f.terminal();
  expect(task.status).toBe('REVIEW');expect(task.iterations).toHaveLength(0);
  await f.service.adopt(project.id,task.taskId);
  const restored=structuredClone(f.project());
  expect(restored.decisions).toEqual(choices);
  expect(currentReuseProposal(restored)?.proposalId).toBe('approved');
  expect(restored.improvementTasks?.at(-1)?.status).toBe('ADOPTED');
});

it('retains the previous candidate on regression and stops after two unimproved rounds without touching holdout',async()=>{
  const f=setup({roundPasses:[['dev2'],['dev1']]});await f.service.start('migration-1234',{jobId:'baseline',maxIterations:5});
  const task=await f.terminal();expect(task.status).toBe('EXHAUSTED');expect(task.iterations).toHaveLength(2);
  expect(task.iterations.every(i=>i.outcome==='RETAINED')).toBe(true);expect(task.bestCandidate.assetId).toBe('original');
  expect(task.finalConsumed).toBe(false);expect(f.project().candidate?.assetId).toBe('original');
});

it('does not turn a known execution-model service failure into another code or Harness rewrite',async()=>{
  const f=setup(),evaluate=f.d.execution.validateExperiment.getMockImplementation()!;
  f.d.execution.validateExperiment.mockImplementation(async(...args)=>{
    const value=await evaluate(...args),result=value.job.report!.cases[0]!.right;
    result.status='failed';result.error='Runtime Launcher HTTP 502: EVAL_PACKAGE_MODEL_CALL_FAILED';return value;
  });
  await f.service.start('migration-1234',{jobId:'baseline'});const task=await f.terminal();
  expect(task.status).toBe('FAILED');expect(task.reason).toContain('执行模型调用未完成');
  expect(f.d.planner.propose).toHaveBeenCalledTimes(1);expect(f.d.execution.validateExperiment).toHaveBeenCalledTimes(1);
  expect(task.finalConsumed).toBe(false);expect(f.project().candidate?.assetId).toBe('original');
});

it('does not feed a failed final holdout back into the planner or permit its reuse',async()=>{
  const f=setup({finalPass:false});await f.service.start('migration-1234',{jobId:'baseline'});
  const task=await f.terminal();expect(task.status).toBe('FAILED');expect(task.finalConsumed).toBe(true);
  expect(f.d.planner.propose).toHaveBeenCalledTimes(1);
  await expect(f.service.adopt('migration-1234',task.taskId)).rejects.toThrow('最终留出集');
  await expect(f.service.start('migration-1234',{jobId:'baseline'})).rejects.toThrow('已经用于最终复核');
});

it('keeps a previously passing case protected when another baseline case has a runtime failure',async()=>{
  const f=setup({roundPasses:[['dev2'],['dev1']]});
  f.jobs.get('baseline')!.report!.cases[1]!.right.status='failed';
  await f.service.start('migration-1234',{jobId:'baseline',maxIterations:2});
  const task=await f.terminal();
  expect(task.iterations.every(item=>item.outcome==='RETAINED')).toBe(true);
  expect(task.bestCandidate.assetId).toBe('original');expect(task.finalConsumed).toBe(false);
});

it('uses the existing Skill proposer but owns technical checks and final verification',async()=>{
  const f=setup({layer:'SKILL'});await f.service.start('migration-1234',{jobId:'baseline'});
  expect((await f.terminal()).status).toBe('REVIEW');
  expect(f.d.optimizers.propose).toHaveBeenCalledWith('baseline',undefined);expect(f.d.technical.validateIsolated).toHaveBeenCalledTimes(1);
  expect(f.d.tools.propose).not.toHaveBeenCalled();
});

it.each([['HARNESS','WAITING_BUILDER'],['CONFIGURATION','WAITING_CONFIGURATION'],['EVALUATION','FAILED']])('preserves external responsibility for %s',async(layer,status)=>{
  const f=setup({layer});await f.service.start('migration-1234',{jobId:'baseline'});
  const task=await f.terminal();expect(task.status).toBe(status);expect(f.d.tools.propose).not.toHaveBeenCalled();
  expect(f.d.execution.validateExperiment).not.toHaveBeenCalled();expect(task.finalConsumed).toBe(false);
});

it('does not run another optimization when the confirmed development target already passes',async()=>{
  const f=setup({baselinePasses:['dev1','dev2']});await f.service.start('migration-1234',{jobId:'baseline'});
  expect((await f.terminal()).status).toBe('REVIEW');expect(f.d.planner.propose).not.toHaveBeenCalled();
  expect(f.d.execution.validateExperiment).toHaveBeenCalledTimes(1);
});

it('does not adopt after concurrent changes to the active candidate',async()=>{
  const f=setup();await f.service.start('migration-1234',{jobId:'baseline'});const task=await f.terminal();
  f.project().candidate={...f.base,assetId:'another'};
  await expect(f.service.adopt('migration-1234',task.taskId)).rejects.toThrow('其他操作');
});

it('stops before evaluation if running configuration changes during proposal',async()=>{
  const f=setup();f.d.tools.propose.mockImplementation(async()=>{f.config.revision++;return {attemptId:'attempt',candidate:f.trial,validations:[],changedPaths:[],summary:'repair'}});
  await f.service.start('migration-1234',{jobId:'baseline'});expect((await f.terminal()).status).toBe('FAILED');
  expect(f.d.execution.validateExperiment).not.toHaveBeenCalled();
});

it('cancels a pending model action without resurrecting the task or evaluating its late result',async()=>{
  const f=setup();let finish!:()=>void;
  f.d.tools.propose.mockImplementation(async()=>{await new Promise<void>(resolve=>{finish=resolve});return {attemptId:'late',candidate:f.trial,validations:[],changedPaths:[],summary:'repair'}});
  const task=await f.service.start('migration-1234',{jobId:'baseline'});
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  await f.service.cancel('migration-1234',task.taskId);finish();
  await vi.waitFor(()=>expect(f.project().improvementTasks?.[0]?.status).toBe('CANCELLED'));
  expect(f.d.execution.validateExperiment).not.toHaveBeenCalled();expect(f.project().candidate?.assetId).toBe('original');
});

it('marks an ownerless persisted running task interrupted instead of replaying effects',async()=>{
  const f=setup({baselinePasses:['dev1','dev2']});await f.service.start('migration-1234',{jobId:'baseline'});await f.terminal();
  f.project().improvementTasks![0]!.status='RUNNING';
  f.project().improvementTasks![0]!.runtimeRequirements={requirementsDigest:'new'} as any;
  f.project().improvementTasks![0]!.originalRuntimeDelivery={requirementsDigest:'old'} as any;
  f.project().runtimeDelivery={requirementsDigest:'new'} as any;
  const restored=new MigrationImprovementTaskService(f.d as unknown as ConstructorParameters<typeof MigrationImprovementTaskService>[0]);
  expect((await restored.list('migration-1234'))[0]?.status).toBe('INTERRUPTED');
  expect(f.project().runtimeDelivery?.requirementsDigest).toBe('old');
  expect(f.d.planner.propose).not.toHaveBeenCalled();
});

it('enforces the wall deadline by aborting the model request',async()=>{
  const f=setup();let observed:AbortSignal|undefined;
  f.d.planner.propose.mockImplementation((async(...args:unknown[])=>{
    observed=args[4] as AbortSignal;
    await new Promise((_resolve,reject)=>observed!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  }) as any);
  vi.useFakeTimers();
  try{
    await f.service.start('migration-1234',{jobId:'baseline',maxDurationSeconds:60});
    await vi.advanceTimersByTimeAsync(60_001);
    expect(observed?.aborted).toBe(true);expect(f.project().improvementTasks?.[0]?.status).toBe('EXHAUSTED');
    expect(f.d.execution.validateExperiment).not.toHaveBeenCalled();
  }finally{vi.useRealTimers();}
});

it('requires admitted matching Builder delivery before resuming',async()=>{
  const f=setup({layer:'HARNESS'});await f.service.start('migration-1234',{jobId:'baseline'});const task=await f.terminal();
  await expect(f.service.resume('migration-1234',task.taskId,{environmentId:'unknown',model:{providerId:'runtime-launcher',modelId:'live',parameters:{}}})).rejects.toThrow('Runtime Launcher');
  expect(f.d.execution.validateExperiment).not.toHaveBeenCalled();expect(task.finalConsumed).toBe(false);
});

it.each(['HARNESS','CONFIGURATION'])('revalidates the frozen suite after explicit %s context replacement',async(layer)=>{
  const f=setup({layer});await f.service.start('migration-1234',{jobId:'baseline'});const waiting=await f.terminal();
  const task=f.project().improvementTasks![0]!;
  const delivery={environmentId:'new-launcher',requirementsDigest:'req-digest',resultDigest:'result-digest',deploymentId:'new-deployment',artifactSha256:'new-artifact',capabilitiesDigest:'caps'};
  const environment={environmentId:'new-launcher',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:'http://127.0.0.1:19000/',delivery};
  (f.d as any).environments={get:async()=>environment};
  if(layer==='HARNESS'){
    task.runtimeRequirements={requirementsDigest:'req-digest',rebuild:{baseline:{deploymentId:'old-deployment',artifactSha256:'old-artifact'}}} as any;
    f.project().runtimeDelivery=delivery as any;
  }
  await f.service.resume('migration-1234',waiting.taskId,{environmentId:'new-launcher',model:{providerId:'runtime-launcher:new-launcher',modelId:'live',parameters:{}}});
  const result=await f.terminal();expect(result.status).toBe('REVIEW');expect(result.finalVerified).toBe(true);
  expect(result.iterations[0]?.outcome).toBe('PROMOTED');expect(result.contextChanges?.[0]?.environmentId).toBe('new-launcher');
  expect(result.frozenSuite.packFingerprint).toBe('frozen-pack');expect(f.d.technical.validateIsolated).toHaveBeenCalledTimes(1);
  expect(f.d.execution.validateExperiment).toHaveBeenCalledTimes(2);expect(f.project().candidate?.assetId).toBe('original');
});

it('refuses a same-artifact Builder delivery without spending the holdout',async()=>{
  const f=setup({layer:'HARNESS'});await f.service.start('migration-1234',{jobId:'baseline'});const task=await f.terminal();
  const delivery={environmentId:'new-launcher',requirementsDigest:'req',resultDigest:'result',deploymentId:'new',artifactSha256:'same'};
  f.project().improvementTasks![0]!.runtimeRequirements={requirementsDigest:'req',rebuild:{baseline:{deploymentId:'old',artifactSha256:'same'}}} as any;
  f.project().runtimeDelivery=delivery as any;
  (f.d as any).environments={get:async()=>({environmentId:'new-launcher',type:'runtime_launcher',delivery})};
  await expect(f.service.resume('migration-1234',task.taskId,{environmentId:'new-launcher',model:{providerId:'runtime-launcher',modelId:'live',parameters:{}}})).rejects.toThrow('新 Builder 交付');
  expect(f.d.execution.validateExperiment).not.toHaveBeenCalled();expect(task.finalConsumed).toBe(false);
});

it('restores the old delivery binding when a waiting rebuild is cancelled without deleting either deployment',async()=>{
  const f=setup({layer:'HARNESS'});const old={environmentId:'old',requirementsDigest:'old'};
  f.project().runtimeDelivery=old as any;
  await f.service.start('migration-1234',{jobId:'baseline'});const task=await f.terminal();
  f.project().improvementTasks![0]!.runtimeRequirements={requirementsDigest:'new'} as any;
  f.project().runtimeDelivery={environmentId:'new',requirementsDigest:'new'} as any;
  await f.service.cancel('migration-1234',task.taskId);
  expect(f.project().runtimeDelivery).toEqual(old);expect(f.project().candidate?.assetId).toBe('original');
});

it('retries the identical development experiment once on Judge failure without generating another candidate',async()=>{
  const f=setup(),evaluate=f.d.execution.validateExperiment.getMockImplementation()!;let count=0;
  f.d.execution.validateExperiment.mockImplementation(async(...args)=>{
    const value=await evaluate(...args);
    if(++count===1)value.job.report!.cases[0]!.judgeError='provider unavailable';
    return value;
  });
  await f.service.start('migration-1234',{jobId:'baseline'});const task=await f.terminal();
  expect(task.status).toBe('REVIEW');expect(task.iterations).toHaveLength(1);expect(f.d.tools.propose).toHaveBeenCalledTimes(1);
  expect(f.d.execution.validateExperiment).toHaveBeenCalledTimes(3);
});

it('does not repeat final holdout when Judge fails and does not blame candidate quality',async()=>{
  const f=setup(),evaluate=f.d.execution.validateExperiment.getMockImplementation()!;
  f.d.execution.validateExperiment.mockImplementation(async(...args)=>{
    const value=await evaluate(...args);
    if(args[2].finalVerification)value.job.report!.cases[0]!.judgeError='provider unavailable';
    return value;
  });
  await f.service.start('migration-1234',{jobId:'baseline'});const task=await f.terminal();
  expect(task.status).toBe('FAILED');expect(task.reason).toContain('不是候选业务退化');expect(task.finalConsumed).toBe(true);
  expect(f.d.execution.validateExperiment).toHaveBeenCalledTimes(2);expect(f.d.tools.propose).toHaveBeenCalledTimes(1);
});

it('changes repair layer across rounds using only the promoted development evidence',async()=>{
  const f=setup({devIds:['dev1','dev2','dev3'],layers:['TOOL','SKILL'],roundPasses:[['dev1','dev2'],['dev1','dev2','dev3']]});
  await f.service.start('migration-1234',{jobId:'baseline'});const task=await f.terminal();
  expect(task.status).toBe('REVIEW');expect(task.iterations.map(i=>[i.layer,i.outcome])).toEqual([['TOOL','PROMOTED'],['SKILL','PROMOTED']]);
  expect(f.d.planner.propose.mock.calls[1]?.[1]).toEqual({jobId:task.iterations[0]!.jobId});
  expect(f.d.optimizers.propose).toHaveBeenCalledWith(task.iterations[0]!.jobId,undefined);
  expect(f.d.execution.validateExperiment).toHaveBeenCalledTimes(3);
  expect(f.project().candidate?.assetId).toBe('original');
});

it('waits for Harness after a local improvement without adopting or consuming holdout',async()=>{
  const f=setup({devIds:['dev1','dev2','dev3'],layers:['TOOL','HARNESS'],roundPasses:[['dev1','dev2']]});
  await f.service.start('migration-1234',{jobId:'baseline'});const task=await f.terminal();
  expect(task.status).toBe('WAITING_BUILDER');expect(task.bestCandidate.assetId).toBe('trial');
  expect(task.finalConsumed).toBe(false);expect(f.project().candidate?.assetId).toBe('original');
  expect(f.d.execution.validateExperiment).toHaveBeenCalledTimes(1);
  expect(f.d.planner.propose.mock.calls[1]?.[1]).toEqual({jobId:task.iterations[0]!.jobId});
});

it('does not evaluate technically failed candidates and stops after two failed attempts',async()=>{
  const f=setup();f.d.tools.propose.mockImplementation(async()=>({attemptId:'bad',candidate:f.trial,changedPaths:[],summary:'failed',validations:[{toolId:'tool',status:'FAILED'}]}));
  await f.service.start('migration-1234',{jobId:'baseline'});const task=await f.terminal();
  expect(task.status).toBe('EXHAUSTED');expect(task.iterations.map(i=>i.outcome)).toEqual(['TECHNICAL_FAILED','TECHNICAL_FAILED']);
  expect(f.d.execution.validateExperiment).not.toHaveBeenCalled();expect(task.finalConsumed).toBe(false);
});

it('stops without edits when the planner abstains',async()=>{
  const f=setup();f.d.planner.propose.mockImplementation(async()=>({status:'ABSTAINED',abstainReason:'证据不足'}) as any);
  await f.service.start('migration-1234',{jobId:'baseline'});const task=await f.terminal();
  expect(task.status).toBe('FAILED');expect(task.reason).toBe('证据不足');
  expect(f.d.tools.propose).not.toHaveBeenCalled();expect(f.d.optimizers.propose).not.toHaveBeenCalled();
  expect(task.finalConsumed).toBe(false);
});

it('rejects a duplicate start while a model call is pending',async()=>{
  const f=setup();let finish!:()=>void;
  f.d.tools.propose.mockImplementation(async()=>{await new Promise<void>(resolve=>{finish=resolve});return {attemptId:'late',candidate:f.trial,validations:[],changedPaths:[],summary:'late'}});
  const [a,b]=await Promise.allSettled([f.service.start('migration-1234',{jobId:'baseline'}),f.service.start('migration-1234',{jobId:'baseline'})]);
  expect([a.status,b.status].sort()).toEqual(['fulfilled','rejected']);
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  const task=f.project().improvementTasks![0]!;await f.service.cancel('migration-1234',task.taskId);finish();await f.service.shutdown();
  expect(f.project().improvementTasks).toHaveLength(1);expect(f.d.execution.validateExperiment).not.toHaveBeenCalled();
});

it('cancels a newly returned execution after stop without accepting its late result',async()=>{
  const f=setup(),evaluate=f.d.execution.validateExperiment.getMockImplementation()!;let finish!:()=>void;
  f.d.execution.validateExperiment.mockImplementation(async(...args)=>{await new Promise<void>(resolve=>{finish=resolve});return evaluate(...args)});
  const task=await f.service.start('migration-1234',{jobId:'baseline'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  await f.service.cancel('migration-1234',task.taskId);finish();await f.service.shutdown();
  expect(f.project().improvementTasks![0]!.status).toBe('CANCELLED');expect(f.d.runs.cancel).toHaveBeenCalled();
  expect(f.project().candidate?.assetId).toBe('original');
});

it('shutdown aborts a pending planning request and does not replay it after restart',async()=>{
  const f=setup();let started=false;
  f.d.planner.propose.mockImplementation((async(...args:unknown[])=>{
    started=true;const signal=args[4] as AbortSignal;
    await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  }) as any);
  await f.service.start('migration-1234',{jobId:'baseline'});await vi.waitFor(()=>expect(started).toBe(true));await f.service.shutdown();
  const restored=new MigrationImprovementTaskService(f.d as unknown as ConstructorParameters<typeof MigrationImprovementTaskService>[0]);
  expect((await restored.list('migration-1234'))[0]!.status).toBe('INTERRUPTED');
  expect(f.d.planner.propose).toHaveBeenCalledTimes(1);expect(f.d.execution.validateExperiment).not.toHaveBeenCalled();
});

it('rejects adoption after private validation inputs changed',async()=>{
  const f=setup();await f.service.start('migration-1234',{jobId:'baseline'});const task=await f.terminal();
  Object.assign(f.config,{validationInputs:{tool:{account:'different'}}});
  await expect(f.service.adopt('migration-1234',task.taskId)).rejects.toThrow('工具测试参数');
  expect(f.project().candidate?.assetId).toBe('original');
});

it('a repeated Judge outage stops without rewriting twice or spending holdout',async()=>{
  const f=setup(),evaluate=f.d.execution.validateExperiment.getMockImplementation()!;
  f.d.execution.validateExperiment.mockImplementation(async(...args)=>{const value=await evaluate(...args);value.job.report!.cases[0]!.judgeError='unavailable';return value});
  await f.service.start('migration-1234',{jobId:'baseline'});const task=await f.terminal();
  expect(task.status).toBe('FAILED');expect(task.finalConsumed).toBe(false);
  expect(f.d.tools.propose).toHaveBeenCalledTimes(1);expect(f.d.execution.validateExperiment).toHaveBeenCalledTimes(2);
});
