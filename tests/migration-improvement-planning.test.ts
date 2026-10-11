import { expect,it,vi } from 'vitest';
import { MigrationImprovementPlanningService } from '../src/migration/application/migration-improvement-planning-service.js';
import type { MigrationProject } from '../src/migration/domain/migration-project.js';
import type { MigrationProjectStore } from '../src/migration/application/migration-project-store.js';
import type { MigrationEvaluationJobReader } from '../src/migration/application/migration-evaluation-ports.js';
import type {MigrationRuntimeConfigurationRepository} from '../src/migration/application/migration-runtime-configuration-repository.js';

const digest='a'.repeat(64);
function fixture(){
  const project={id:'migration-1234',candidate:{artifactSha256:digest},runs:[{jobId:'job-1',candidateDigest:digest,
    solutionRevisions:{right:{revisionId:'b'.repeat(64)}},suiteSnapshot:{cases:[{caseId:'dev-1'}],holdoutCases:[{caseId:'secret-1'}]},
    declaredPlan:{configuration:{selectedCaseIds:[]}}}],improvementPlans:[]} as unknown as MigrationProject;
  const job={status:'completed',report:{cases:[
    {caseId:'dev-1',prompt:'开发题',right:{status:'completed',toolCalls:[{name:'lookup',status:'failed'}]},judge:{summary:'查询失败',winner:'left'}},
    {caseId:'secret-1',prompt:'HOLDOUT_SECRET',right:{status:'completed',toolCalls:[]},judge:{summary:'HOLDOUT_SECRET',winner:'right'}},
  ]}};
  const projects={get:async()=>project,save:async()=>undefined,runExclusive:async(_id:string,action:()=>Promise<unknown>)=>action()} as MigrationProjectStore;
  return {project,job,projects,jobs:{get:()=>job} as unknown as MigrationEvaluationJobReader};
}

it('proposes an evidence-grounded layer without exposing holdout cases to the model',async()=>{
  const {project,projects,jobs}=fixture();
  const planner=vi.fn(async(input:{cases:Array<{caseId:string;task:string}>})=>{
    expect(JSON.stringify(input)).not.toContain('HOLDOUT_SECRET');
    expect(input.cases.map(item=>item.caseId)).toEqual(['dev-1']);
    return {status:'PROPOSED',hypothesis:{layer:'TOOL',issue:'工具执行失败',expectedBehavior:'lookup 返回业务数据',evidenceCaseIds:['dev-1'],
      validation:'先做 Tool 技术验证，再跑开发题',risk:'接口可能仍不可用',confidence:'MEDIUM'}};
  });
  const service=new MigrationImprovementPlanningService(projects,jobs,planner,()=> 'fixture-model');
  const plan=await service.propose(project.id,{jobId:'job-1'});
  expect(plan.hypothesis?.layer).toBe('TOOL');
  expect(project.improvementPlans).toHaveLength(1);
  expect(plan.developmentCaseIds).toEqual(['dev-1']);
});
it('allows Harness contracts to cite actual line-addressable development telemetry without inventing Skill source',async()=>{
  const {project,projects,jobs,job}=fixture();
  job.report.cases[0]!.right.status='failed';
  Object.assign(job.report.cases[0]!.right,{error:'EVAL_PACKAGE_ITERATION_LIMIT',metadata:{executionBudget:{maxAgentIterations:2,owner:'HARNESS',changeMechanism:'BUILDER_REBUILD'},secret:'PRIVATE_TOKEN'}});
  const planner=vi.fn(async(input:any)=>{
    expect(JSON.stringify(input.runtimeEvidence)).not.toContain('HOLDOUT_SECRET');expect(JSON.stringify(input.runtimeEvidence)).not.toContain('PRIVATE_TOKEN');
    const document=input.runtimeEvidence[0],lines=document.content.split('\n'),line=lines.findIndex((value:string)=>value.includes('maxAgentIterations'))+1;
    expect(line).toBeGreaterThan(0);
    return {status:'PROPOSED',hypothesis:{layer:'HARNESS',issue:'Budget too small',expectedBehavior:'Complete the workflow',evidenceCaseIds:['dev-1'],validation:'Re-run frozen development cases',risk:'Budget cost',confidence:'HIGH',
      requiredCapabilities:[{id:'budget',name:'Agent budget',required:true,reason:'Observed iteration limit',contract:{inputSchema:{},outputSchema:{},errorSchema:{},semantics:'Sufficient native iterations'},constraints:{permissions:[],sideEffects:'none',isolation:'per instance'},preferredTargetCapability:null,consumerTools:[],evidence:[{path:document.path,line,detail:'Actual native execution budget is 2'}]}]}};
  });
  const service=new MigrationImprovementPlanningService(projects,jobs,planner,()=> 'fixture-model');
  const result=await service.propose(project.id,{jobId:'job-1'});
  expect(result.hypothesis?.requiredCapabilities?.[0]?.evidence[0]?.path).toContain('runtime-evidence/job-1/dev-1.json');
});

it('persists only correction count and digests from the planning model',async()=>{
  const {project,projects,jobs}=fixture();
  const digest='f'.repeat(64);
  const planner=async()=>({judgement:{status:'ABSTAINED',reason:'没有足够证据'},
    outputCorrection:{attempts:1,originalDigest:digest,acceptedDigest:'e'.repeat(64)}});
  const service=new MigrationImprovementPlanningService(projects,jobs,planner,()=> 'fixture-model');
  const plan=await service.propose(project.id,{jobId:'job-1'});
  expect(plan.outputCorrection).toEqual({attempts:1,originalDigest:digest,acceptedDigest:'e'.repeat(64)});
});

it('rejects model citations to nonexistent or held-out cases',async()=>{
  const {project,projects,jobs}=fixture();
  const service=new MigrationImprovementPlanningService(projects,jobs,async()=>({status:'PROPOSED',hypothesis:{layer:'SKILL',issue:'x',expectedBehavior:'y',
    evidenceCaseIds:['secret-1'],validation:'z',risk:'r',confidence:'LOW'}}),()=> 'fixture-model');
  await expect(service.propose(project.id,{jobId:'job-1'})).rejects.toThrow('非开发集');
  expect(project.improvementPlans).toHaveLength(0);
});

it('exposes configuration presence but never its secret value to the planner',async()=>{
  const {project,projects,jobs}=fixture();
  project.sourceInspection={dependencyAnalysis:{dependencies:[{id:'token',key:'AUTH_TOKEN',owner:'RUNTIME',action:'INJECT',
    sensitive:true,schema:{type:'string'}}]}} as unknown as MigrationProject['sourceInspection'];
  const configs={get:async()=>({values:{token:'PRIVATE_TOKEN_SHOULD_NOT_REACH_MODEL'}})} as MigrationRuntimeConfigurationRepository;
  const service=new MigrationImprovementPlanningService(projects,jobs,async input=>{
    expect(JSON.stringify(input)).not.toContain('PRIVATE_TOKEN_SHOULD_NOT_REACH_MODEL');
    expect(input.runtimeConfiguration).toEqual([{dependencyId:'token',key:'AUTH_TOKEN',provided:true,valid:true,sensitive:true}]);
    return {status:'ABSTAINED',reason:'配置存在，证据不足'};
  },()=> 'fixture-model',configs);
  await service.propose(project.id,{jobId:'job-1'});
});

it('rejects final verification as a planning source even if it also contains development cases',async()=>{
  const f=fixture();f.project.runs[0]!.declaredPlan!.configuration.includeHoldout=true;
  const planner=vi.fn();const service=new MigrationImprovementPlanningService(f.projects,f.jobs,planner,()=> 'fixture-model');
  await expect(service.propose(f.project.id,{jobId:'job-1'})).rejects.toThrow('最终留出集');expect(planner).not.toHaveBeenCalled();
});

it('distinguishes missing execution traces from no calls and includes matching technical checks without inputs',async()=>{
  const f=fixture();f.job.report.cases[0]!.right.status='failed';
  Object.assign(f.job.report.cases[0]!.right,{metadata:{executionBudget:{maxAgentIterations:2,owner:'HARNESS',changeMechanism:'BUILDER_REBUILD',private:'PRIVATE_BUDGET_INPUT'}}});
  f.project.technicalValidations=[{toolId:'lookup',assetDigest:digest,status:'PASSED',
    stages:[{name:'TOOLS_CALL',passed:true,message:'PRIVATE_TOOL_INPUT'}],inputFields:['secret']} as any];
  const service=new MigrationImprovementPlanningService(f.projects,f.jobs,async input=>{
    expect(input.cases[0]).toMatchObject({toolTraceStatus:'PARTIAL_OR_UNAVAILABLE',runtimeIdentityVerified:false,streamCompleted:false});
    expect(input.cases[0]?.executionBudget).toEqual({maxAgentIterations:2,owner:'HARNESS',changeMechanism:'BUILDER_REBUILD'});expect(JSON.stringify(input)).not.toContain('PRIVATE_BUDGET_INPUT');
    expect(input.technicalEvidence).toEqual([{toolId:'lookup',status:'PASSED',stages:[{name:'TOOLS_CALL',passed:true}]}]);
    expect(JSON.stringify(input)).not.toContain('PRIVATE_TOOL_INPUT');
    return {status:'ABSTAINED',reason:'缺少完整执行证据'};
  },()=> 'fixture-model');
  await service.propose(f.project.id,{jobId:'job-1'});
});
