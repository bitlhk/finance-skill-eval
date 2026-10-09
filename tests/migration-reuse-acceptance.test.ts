import {expect,it,vi} from 'vitest';
import {MigrationReuseAcceptanceService} from '../src/migration/application/migration-reuse-acceptance-service.js';
import {reuseAcceptancePlanSchema,reuseAcceptancePlanIssues} from '../src/migration/domain/migration-reuse-acceptance.js';
import {reuseInputDigest} from '../src/migration/domain/migration-reuse-design.js';
import {simpleMigrationCases,simpleMigrationSuiteSchema,normalizeOriginalServiceSuite} from '../src/migration/domain/simple-migration-suite.js';
import {inspectionFixture} from './analysis-fixture.js';
import type {MigrationProject} from '../src/migration/domain/migration-project.js';
import {ReuseAcceptanceError} from '../src/migration/domain/migration-reuse-failure.js';

function fixture(){
 const inspection=inspectionFixture([]),source={assetId:inspection.assetId,artifactSha256:'a'.repeat(64)},candidate={assetId:'candidate',artifactSha256:'b'.repeat(64),skillId:'fixture',version:'1'};
 const project={id:'migration-fixture',source,candidate,runs:[],suiteIds:[],sourceInspection:inspection,inspection:{...inspection,reuseConformance:{proposalId:'proposal',candidateDigest:candidate.artifactSha256}},candidateReuseProposalId:'proposal',
 reuseProposal:{proposalId:'proposal',inputDigest:reuseInputDigest(inspection,[],source.artifactSha256),sourceDigest:source.artifactSha256,approvedAt:'now',design:{acceptanceChecks:[{id:'reusable',purpose:'Isolate data and retain same-case conversation',procedure:'Run two isolated cases, then run again in a fresh instance',expectedResult:'Each case gets only its own data'}]}}} as unknown as MigrationProject;
 const plan={name:'Reuse',groups:[{id:'first',cases:[{id:'one',input:'Answer A',criteria:['A']},{id:'two',input:'Answer B',criteria:['B']}]},{id:'fresh',cases:[{id:'three',input:'Answer C',criteria:['C']}]}],checks:[{checkId:'reusable',caseIds:['one','two','three'],criteria:['No cross-case data; fresh instance still works']}],unresolvedQuestions:[]};
 const launcher={environmentId:'launcher',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:'http://127.0.0.1:19000/',updatedAt:'now'};
 const selected={environmentId:'selected',type:'execution_environment',launcherEnvironmentId:'launcher'};
 const capabilities={models:[{modelId:'model',upstreamModelId:'upstream'}],features:{multiTurn:true}};
 const config={revision:0,values:{},checks:[]},jobs=new Map<string,any>();let suite:any;
 const projects={get:async()=>structuredClone(project),save:async(value:MigrationProject)=>Object.assign(project,structuredClone(value)),runExclusive:async(_id:string,action:()=>Promise<any>)=>action()};
 const model=vi.fn(async({mode}:any)=>mode==='PLAN'?structuredClone(plan):mode==='COVERAGE'?{status:'COVERED',reasons:[]}:{checks:[{checkId:'reusable',status:'PASSED',reason:'Observed isolated results',caseIds:['one','two','three']}]});
 const execution=vi.fn(async()=>{const jobId=`job-${jobs.size}`,instanceId=`instance-${jobs.size}`;const job={jobId,status:'completed',report:{cases:suite.cases.map((c:any)=>({caseId:c.id,right:{status:'completed',runtimeIdentityVerified:true,streamCompleted:true,output:c.input,toolCalls:[],metadata:{skillArtifactSha256:candidate.artifactSha256,instanceId,caseScopeId:c.id}},judge:{goalAssessment:{verdict:'PASS'}}}))}};jobs.set(jobId,job);return {job}});
 const cancel=vi.fn(async()=>undefined);
 const service=new MigrationReuseAcceptanceService({projects:projects as never,configs:{get:async()=>config} as never,environments:{get:async(id:string)=>(id==='selected'?selected:launcher) as never,preflight:async()=>({status:'ready',capabilities:capabilities as never})},
 suites:{importSimple:async(_id:string,value:any)=>{suite=value;return {preparationId:'suite'}}} as never,execution:{validateReuseAcceptance:execution} as never,jobs:{get:(id:string)=>jobs.get(id)},runs:{cancel} as never,model});
 async function approve(){const saved=await service.propose(project.id,{environmentId:'selected',modelId:'model'});await service.approve(project.id,{planId:saved.planId,inputDigest:saved.inputDigest});return saved;}
 async function finish(){await vi.waitFor(()=>expect(project.reuseAcceptanceResults?.at(-1)?.status).not.toBe('RUNNING'));return service.summary(project.id);}
 return {project,plan,launcher,capabilities,config,jobs,service,model,execution,cancel,approve,finish};
}

it('executes frozen groups through existing suite/runtime/Judge pipeline and binds the result',async()=>{
 const f=fixture(),p=await f.approve();await f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest});
 const summary=await f.finish();expect(summary.status).toBe('PASSED');expect(summary.result?.checks[0]?.status).toBe('PASSED');expect(f.execution).toHaveBeenCalledTimes(2);expect(f.model.mock.calls.map(c=>c[0].mode)).toEqual(['PLAN','COVERAGE','VERIFY']);
 f.config.revision++;expect((await f.service.summary(f.project.id)).status).toBe('STALE');await f.service.shutdown();
});
it.each(['missing-check','duplicate-case','unknown-case','unmapped-case','unresolved'] as const)('refuses structural undercoverage: %s',async change=>{
 const f=fixture();if(change==='missing-check')f.project.reuseProposal!.design.acceptanceChecks.push({id:'another',purpose:'Other',procedure:'Other',expectedResult:'Other'});if(change==='duplicate-case')f.plan.groups[1]!.cases[0]!.id='one';if(change==='unknown-case')f.plan.checks[0]!.caseIds=['unknown'];if(change==='unmapped-case')f.plan.checks[0]!.caseIds=['one'];if(change==='unresolved')f.plan.unresolvedQuestions=['Cannot redeploy Launcher'] as never;
 const saved=await f.service.propose(f.project.id,{environmentId:'selected',modelId:'model',plan:f.plan});expect(saved.coverage.status).toBe('INCOMPLETE');expect(f.model).not.toHaveBeenCalled();await expect(f.service.approve(f.project.id,{planId:saved.planId,inputDigest:saved.inputDigest})).rejects.toThrow('完整覆盖');
});
it('requires independent model coverage review even for manually authored plans',async()=>{
 const f=fixture();f.model.mockResolvedValueOnce({status:'INCOMPLETE',reasons:['Not a real Launcher redeployment']} as never);
 const saved=await f.service.propose(f.project.id,{environmentId:'selected',modelId:'model',plan:f.plan});expect(saved.coverage.status).toBe('INCOMPLETE');expect(f.model.mock.calls[0]![0].mode).toBe('COVERAGE');
});
it('does not turn supporting coverage explanations into blockers',async()=>{
 const f=fixture();f.model.mockResolvedValueOnce({status:'COVERED',reasons:['Each original requirement has matching isolated and fresh-instance execution evidence']} as never);
 const p=await f.service.propose(f.project.id,{environmentId:'selected',modelId:'model',plan:f.plan});expect(p.coverage.status).toBe('COVERED');await expect(f.service.approve(f.project.id,{planId:p.planId,inputDigest:p.inputDigest})).resolves.toHaveProperty('approvedAt');
});
it.each(['launcher','config','capabilities','candidate','proposal'] as const)('invalidates approval on binding changes: %s',async change=>{
 const f=fixture(),p=await f.approve();if(change==='launcher')f.launcher.baseUrl='http://127.0.0.1:19001/';if(change==='config')f.config.revision++;if(change==='capabilities')f.capabilities.features.multiTurn=false;if(change==='candidate')f.project.candidate!.artifactSha256='c'.repeat(64);if(change==='proposal')f.project.reuseProposal!.approvedAt=undefined;
 await expect(f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest})).rejects.toThrow();expect(f.execution).not.toHaveBeenCalled();
});
it.each(['scope','instance','identity','judge-fail','judge-missing','verdict-reference'] as const)('never passes insufficient or contradictory evidence: %s',async change=>{
 const f=fixture(),p=await f.approve(),original=f.execution.getMockImplementation()!;
 f.execution.mockImplementation(async()=>{const result=await original();for(const c of result.job.report.cases){if(change==='scope')c.right.metadata.caseScopeId='shared';if(change==='instance')c.right.metadata.instanceId='shared';if(change==='identity')c.right.runtimeIdentityVerified=false;if(change==='judge-fail')c.judge.goalAssessment.verdict='FAIL';if(change==='judge-missing')delete c.judge.goalAssessment;}return result});
 if(change==='verdict-reference')f.model.mockResolvedValueOnce({checks:[{checkId:'reusable',status:'PASSED',reason:'claim',caseIds:['unknown']}]} as never);
 await f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest});const summary=await f.finish();expect(summary.status).not.toBe('PASSED');if(change==='judge-fail')expect(summary.status).toBe('FAILED');
 if(['judge-fail','judge-missing'].includes(change))expect(summary.result?.failure).toMatchObject({phase:'VERIFICATION',caseId:'one',jobId:'job-0',code:change==='judge-fail'?'REUSE_CHECK_FAILED':'REUSE_CHECK_INDETERMINATE'});
 await f.service.shutdown();
});
it('marks orphaned RUNNING records interrupted, without replaying tools',async()=>{
 const f=fixture(),p=await f.approve();f.project.reuseAcceptanceResults=[{taskId:'old',planId:p.planId,planDigest:p.inputDigest,binding:p.binding,startedAt:'now',status:'RUNNING',jobs:[],checks:[]}];
 expect((await f.service.summary(f.project.id)).status).toBe('INTERRUPTED');expect(f.execution).not.toHaveBeenCalled();
});
it('maps actual turns and mandatory per-turn tools, never a simulated dialogue prompt',async()=>{
 const f=fixture(),plan=reuseAcceptancePlanSchema.parse(f.plan);plan.groups[0]!.cases[0]!.turns=[{query:'Find products',requiredTools:['find_products']},{query:'Use the selected product',requiredTools:['use_product']}];
 const suite=simpleMigrationSuiteSchema.parse({name:'Real turns',cases:plan.groups[0]!.cases});expect(simpleMigrationCases(suite)[0]).toMatchObject({taskMode:'multi_turn',turns:plan.groups[0]!.cases[0]!.turns,requiredTools:['find_products','use_product']});expect(reuseAcceptancePlanIssues(f.project,plan)).toEqual([]);
 expect(()=>normalizeOriginalServiceSuite({mode:'service_comparison',...suite})).toThrow('未约定会话');f.capabilities.features.multiTurn=false;const saved=await f.service.propose(f.project.id,{environmentId:'selected',modelId:'model',plan});expect(saved.coverage.status).toBe('INCOMPLETE');
});

it('rejects an edited frozen plan instead of executing it under the old approval',async()=>{
 const f=fixture(),p=await f.approve();f.project.reuseAcceptancePlan!.plan.groups[0]!.cases[0]!.input='Altered after approval';
 await expect(f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest})).rejects.toThrow('确认');expect(f.execution).not.toHaveBeenCalled();
});
it('cannot turn cancellation into a later model PASS',async()=>{
 const f=fixture(),p=await f.approve();let release!:()=>void,verifyStarted=false;
 f.model.mockImplementation(async({mode}:any)=>{if(mode==='VERIFY'){verifyStarted=true;await new Promise<void>(r=>{release=r});return {checks:[{checkId:'reusable',status:'PASSED',reason:'Late model result',caseIds:['one','two','three']}]}}return {status:'COVERED',reasons:[]}});
 const task=await f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest});await vi.waitFor(()=>expect(verifyStarted).toBe(true));await f.service.cancel(f.project.id,task.taskId);release();await f.service.shutdown();
 expect((await f.service.summary(f.project.id)).status).toBe('CANCELLED');
});
it('creates integrated validation only for actually called tools after all reuse checks pass',async()=>{
 const f=fixture();f.project.inspection!.tools=[{toolId:'called',name:'called'},{toolId:'not-called',name:'not-called'}] as never;const p=await f.approve();
 const original=f.execution.getMockImplementation()!;f.execution.mockImplementation(async()=>{const result=await original();for(const c of result.job.report.cases)c.right.toolCalls=[{name:'called',status:'completed'}];return result});
 await f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest});expect((await f.finish()).status).toBe('PASSED');expect(f.project.technicalValidations?.map(v=>[v.toolId,v.mode])).toEqual([['called','RUNTIME_INTEGRATED']]);await f.service.shutdown();
});
it('invalidates a frozen acceptance on candidate inspection or approved-design changes',async()=>{
 const f=fixture(),p=await f.approve();f.project.inspection!.tools=[{name:'changed'}] as never;await expect(f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest})).rejects.toThrow('失效');
 const g=fixture(),q=await g.approve();g.project.reuseProposal!.design.scope='Changed scope';await expect(g.service.start(g.project.id,{planId:q.planId,inputDigest:q.inputDigest})).rejects.toThrow('失效');
});
it('normalizes a one-query turns representation without changing data or required tools',()=>{
 const suite=simpleMigrationSuiteSchema.parse({name:'single',cases:[{id:'one',input:'evaluation objective only',criteria:['Expected output'],turns:[{query:'actual user query',requiredTools:['lookup']}]}]});
 expect(simpleMigrationCases(suite)[0]).toMatchObject({prompt:'actual user query',taskMode:'single_turn',requiredTools:['lookup']});expect(simpleMigrationCases(suite)[0]).not.toHaveProperty('turns');
});
it.each(['failed-case','missing-identity','judge-error'])('locates execution failure without exposing raw errors: %s',async kind=>{
 const f=fixture(),p=await f.approve(),original=f.execution.getMockImplementation()!;
 f.execution.mockImplementation(async()=>{const result=await original(),c=result.job.report.cases[0];
  if(kind==='failed-case'){c.right.status='failed';c.right.error='PRIVATE_API_KEY';}
  if(kind==='missing-identity')c.right.runtimeIdentityVerified=false;
  if(kind==='judge-error')c.judgeError='PRIVATE_JUDGE_ERROR';return result;});
 await f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest});const summary=await f.finish();
 expect(summary.result?.failure).toMatchObject({phase:'EXECUTION',groupId:'first',caseId:'one',jobId:'job-0',
  code:kind==='failed-case'?'CASE_EXECUTION_FAILED':kind==='judge-error'?'CASE_JUDGE_FAILED':'RUNTIME_EVIDENCE_MISSING'});
 expect(JSON.stringify(summary)).not.toContain('PRIVATE_');expect(summary.status).toBe('INDETERMINATE');await f.service.shutdown();
});
it('preserves safe model failure phase and never discloses a provider exception',async()=>{
 const f=fixture(),p=await f.approve();f.model.mockRejectedValueOnce(new ReuseAcceptanceError({phase:'VERIFICATION',code:'MODEL_OUTPUT_INVALID',message:'结果判定字段不符合要求',fields:['checks (invalid_type)']}));
 await f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest});expect((await f.finish()).result?.failure).toMatchObject({phase:'VERIFICATION',code:'MODEL_OUTPUT_INVALID'});await f.service.shutdown();
 const g=fixture(),q=await g.approve();g.execution.mockRejectedValueOnce(new Error('PRIVATE_TOKEN'));
 await g.service.start(g.project.id,{planId:q.planId,inputDigest:q.inputDigest});expect(JSON.stringify(await g.finish())).not.toContain('PRIVATE_TOKEN');await g.service.shutdown();
});
it('returns safe field diagnostics for malformed manual plans',async()=>{
 const f=fixture();await expect(f.service.propose(f.project.id,{environmentId:'selected',modelId:'model',plan:{name:'malformed',groups:'PRIVATE_INPUT'}})).rejects.toMatchObject({failure:{phase:'PLAN',code:'PLAN_INPUT_INVALID'}});
 try{await f.service.propose(f.project.id,{environmentId:'selected',modelId:'model',plan:{name:'malformed',groups:'PRIVATE_INPUT'}})}catch(error:any){expect(error.message).toContain('groups：类型不正确');expect(error.message).not.toContain('PRIVATE_INPUT');}
});
it('distinguishes verified Runtime model failures from raw SDK exceptions',async()=>{
 const f=fixture(),p=await f.approve(),original=f.execution.getMockImplementation()!;
 f.execution.mockImplementation(async()=>{const result=await original();result.job.report.cases[0].right.status='failed';result.job.report.cases[0].right.error='EVAL_PACKAGE_MODEL_CALL_FAILED';return result});
 await f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest});expect((await f.finish()).result?.failure).toMatchObject({code:'RUNTIME_MODEL_FAILED',caseId:'one'});await f.service.shutdown();
});
