import {expect,it,vi} from 'vitest';
import {MigrationReuseAcceptanceService} from '../src/migration/application/migration-reuse-acceptance-service.js';
import {reuseAcceptancePlanSchema,reuseAcceptancePlanIssues} from '../src/migration/domain/migration-reuse-acceptance.js';
import {reuseInputDigest} from '../src/migration/domain/migration-reuse-design.js';
import {simpleMigrationCases,simpleMigrationSuiteSchema,normalizeOriginalServiceSuite} from '../src/migration/domain/simple-migration-suite.js';
import {inspectionFixture} from './analysis-fixture.js';
import type {MigrationProject} from '../src/migration/domain/migration-project.js';
import {ReuseAcceptanceError} from '../src/migration/domain/migration-reuse-failure.js';
import {reuseExecutionContract} from '../src/migration/domain/migration-reuse-execution-contract.js';
import {SkillStore} from '../src/service/skill-store.js';
import {mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {canonicalSha256} from '../src/shared/json-canonicalization.js';

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
 const readArchive=vi.fn(async():Promise<Record<string,Uint8Array>>=>({'SKILL.md':strToU8('Actual delivered workflow')}));
 const environmentRecords=new Map<string,unknown>([['selected',selected],['launcher',launcher]]);
 const environments={get:async(id:string)=>(environmentRecords.get(id)??null) as never,preflight:async()=>({status:'ready',capabilities:capabilities as never})};
 const service=new MigrationReuseAcceptanceService({projects:projects as never,configs:{get:async()=>config} as never,skills:{readArchive} as never,environments,
 suites:{importSimple:async(_id:string,value:any)=>{suite=value;return {preparationId:'suite'}}} as never,execution:{validateReuseAcceptance:execution} as never,jobs:{get:(id:string)=>jobs.get(id)},runs:{cancel} as never,model});
 async function approve(){const saved=await service.propose(project.id,{environmentId:'selected',modelId:'model'});await service.approve(project.id,{planId:saved.planId,inputDigest:saved.inputDigest});return saved;}
 async function finish(){await vi.waitFor(()=>expect(project.reuseAcceptanceResults?.at(-1)?.status).not.toBe('RUNNING'));return service.summary(project.id);}
 return {project,plan,launcher,capabilities,config,jobs,service,model,execution,cancel,readArchive,approve,finish,environmentRecords,environments};
}

function deploymentFixture(){
 const f=fixture();
 const delivery=(deploymentId:string)=>({schemaVersion:'finance.runtime-launcher-delivery-record.v1',buildId:'build',requestId:'request',deploymentId,
  artifactSha256:'d'.repeat(64),capabilitiesDigest:canonicalSha256(f.capabilities),resultDigest:'e'.repeat(64),builder:{name:'external',version:'1'},
  acceptedAt:new Date().toISOString(),expiresAt:null,evalConformance:{status:'PASSED',testedAt:new Date().toISOString(),checks:['capabilities','create','status','execute','evidence','delete']}});
 Object.assign(f.launcher,{delivery:delivery('deployment-primary')});
 const other={...f.launcher,environmentId:'other',baseUrl:'http://127.0.0.1:19002/',delivery:delivery('deployment-other')};
 f.environmentRecords.set('other',other);
 const plan=reuseAcceptancePlanSchema.parse(f.plan);plan.groups[1]!.runtime={environmentId:'other',modelId:'model'};
 const choice={environmentId:'selected',modelId:'model',additionalRuntimes:[{environmentId:'other',modelId:'model'}],plan};
 return {...f,other,choice};
}

it('executes separate frozen admitted deployments, not aliases or merely fresh instances',async()=>{
 const f=deploymentFixture(),p=await f.service.propose(f.project.id,f.choice);
 expect(p.coverage.status).toBe('COVERED');expect(p.binding.additionalRuntimes?.[0]).toMatchObject({deploymentId:'deployment-other',environmentId:'other'});
 await f.service.approve(f.project.id,{planId:p.planId,inputDigest:p.inputDigest});await f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest});
 expect((await f.finish()).status).toBe('PASSED');
 expect(f.execution.mock.calls.map((args:any)=>args[1].configuration.runtime.environmentId)).toEqual(['selected','other']);
 const verified=(f.model.mock.calls.find(c=>c[0].mode==='VERIFY')![0] as any).context.observed;
 expect(new Set(verified.map((c:any)=>c.deploymentId))).toEqual(new Set(['deployment-primary','deployment-other']));
 expect(JSON.stringify(verified)).not.toContain('127.0.0.1');await f.service.shutdown();
});
it.each(['alias-endpoint','alias-deployment','unadmitted','expired','capability-drift','wrong-model'] as const)('rejects invalid cross-deployment admission: %s',async change=>{
 const f=deploymentFixture();if(change==='alias-endpoint')f.other.baseUrl=f.launcher.baseUrl;
 if(change==='alias-deployment')f.other.delivery.deploymentId='deployment-primary';
 if(change==='unadmitted')delete (f.other as any).delivery;
 if(change==='expired')(f.other.delivery as any).expiresAt='2020-01-01T00:00:00.000Z';
 if(change==='capability-drift')f.other.delivery.capabilitiesDigest='f'.repeat(64);
 if(change==='wrong-model')f.choice.additionalRuntimes[0]!.modelId='unknown';
 await expect(f.service.propose(f.project.id,f.choice)).rejects.toThrow();expect(f.model).not.toHaveBeenCalled();expect(f.execution).not.toHaveBeenCalled();
});
it.each(['unselected-target','unused-target','missing-primary'] as const)('keeps incomplete deployment topology unapproved: %s',async change=>{
 const f=deploymentFixture();if(change==='unselected-target')f.choice.plan.groups[1]!.runtime={environmentId:'unknown',modelId:'model'};
 if(change==='unused-target')delete f.choice.plan.groups[1]!.runtime;
 if(change==='missing-primary')f.choice.plan.groups[0]!.runtime={environmentId:'other',modelId:'model'};
 const p=await f.service.propose(f.project.id,f.choice);expect(p.coverage.status).toBe('INCOMPLETE');expect(f.model).not.toHaveBeenCalled();
 await expect(f.service.approve(f.project.id,{planId:p.planId,inputDigest:p.inputDigest})).rejects.toThrow('完整覆盖');
});
it('invalidates approval if a secondary deployment changes, including refresh',async()=>{
 const f=deploymentFixture(),p=await f.service.propose(f.project.id,f.choice);await f.service.approve(f.project.id,{planId:p.planId,inputDigest:p.inputDigest});
 f.other.updatedAt='changed';expect((await f.service.summary(f.project.id)).current).toBe(false);
 await expect(f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest})).rejects.toThrow('失效');expect(f.execution).not.toHaveBeenCalled();
});
it('treats instance ids as Launcher-scoped while still rejecting same-Launcher shared instances',async()=>{
 const f=deploymentFixture(),p=await f.service.propose(f.project.id,f.choice);await f.service.approve(f.project.id,{planId:p.planId,inputDigest:p.inputDigest});
 const original=f.execution.getMockImplementation()!;f.execution.mockImplementation(async()=>{const r=await original();for(const c of r.job.report.cases)c.right.metadata.instanceId='launcher-local-id';return r});
 await f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest});expect((await f.finish()).status).toBe('PASSED');await f.service.shutdown();
});

it('executes frozen groups through existing suite/runtime/Judge pipeline and binds the result',async()=>{
 const f=fixture(),p=await f.approve();await f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest});
 const summary=await f.finish();expect(summary.status).toBe('PASSED');expect(summary.result?.checks[0]?.status).toBe('PASSED');expect(f.execution).toHaveBeenCalledTimes(2);expect(f.model.mock.calls.map(c=>c[0].mode)).toEqual(['PLAN','COVERAGE','VERIFY']);
 expect((f.model.mock.calls[0]![0] as any).context.executionContract).toEqual(reuseExecutionContract);
 const evidenceContract=(f.model.mock.calls[0]![0] as any).context.evaluatorEvidence;
 expect(evidenceContract.caseJudge.available.join(' ')).toContain('可选 workspaceInputMatches');
 expect(evidenceContract.caseJudge.unavailable.join(' ')).toContain('workspaceFiles 正文');
 expect(evidenceContract.caseJudge.unavailable.join(' ')).toContain('脚本内部读取');
 expect(evidenceContract.checkJudge.available.join(' ')).toContain('真实 candidateFiles');
 expect(evidenceContract.checkJudge.rule).toContain('原承诺不能删减');
 expect((f.model.mock.calls[2]![0] as any).context).toMatchObject({candidateFiles:{'SKILL.md':'Actual delivered workflow'},candidateReview:{proposalId:'proposal',candidateDigest:'b'.repeat(64)},artifactDigest:'b'.repeat(64)});
 expect(f.readArchive).toHaveBeenLastCalledWith('candidate');
 f.config.revision++;expect((await f.service.summary(f.project.id)).status).toBe('STALE');await f.service.shutdown();
});
it.each(['missing-check','duplicate-case','unknown-case','unmapped-case','unresolved'] as const)('refuses structural undercoverage: %s',async change=>{
 const f=fixture();if(change==='missing-check')f.project.reuseProposal!.design.acceptanceChecks.push({id:'another',purpose:'Other',procedure:'Other',expectedResult:'Other'});if(change==='duplicate-case')f.plan.groups[1]!.cases[0]!.id='one';if(change==='unknown-case')f.plan.checks[0]!.caseIds=['unknown'];if(change==='unmapped-case')f.plan.checks[0]!.caseIds=['one'];if(change==='unresolved')f.plan.unresolvedQuestions=['Cannot redeploy Launcher'] as never;
 const saved=await f.service.propose(f.project.id,{environmentId:'selected',modelId:'model',plan:f.plan});expect(saved.coverage.status).toBe('INCOMPLETE');expect(f.model).not.toHaveBeenCalled();await expect(f.service.approve(f.project.id,{planId:saved.planId,inputDigest:saved.inputDigest})).rejects.toThrow('完整覆盖');
});
it('uses intact same-binding incomplete coverage to inform a new plan without rerating old verdicts',async()=>{
 const f=fixture();
 f.model.mockImplementation(async({mode}:any)=>mode==='PLAN'?structuredClone(f.plan):{status:'INCOMPLETE',reasons:['Move session identity comparison to checks']});
 const first=await f.service.propose(f.project.id,{environmentId:'selected',modelId:'model'});
 await f.service.propose(f.project.id,{environmentId:'selected',modelId:'model'});
 expect((f.model.mock.calls[2]![0] as any).context.planningFeedback).toEqual({previousPlan:first.plan,coverage:first.coverage});
 expect(first.coverage.status).toBe('INCOMPLETE');expect(f.execution).not.toHaveBeenCalled();
 f.config.revision++;
 await f.service.propose(f.project.id,{environmentId:'selected',modelId:'model'});
 expect((f.model.mock.calls[4]![0] as any).context.planningFeedback).toBeUndefined();
});
it('never uses tampered or operator-authored plan history as automatic planning feedback',async()=>{
 const f=fixture();f.model.mockImplementation(async({mode}:any)=>mode==='PLAN'?structuredClone(f.plan):{status:'INCOMPLETE',reasons:['Missing coverage']});
 await f.service.propose(f.project.id,{environmentId:'selected',modelId:'model'});
 f.project.reuseAcceptancePlan!.coverage.reasons=['Tampered'];
 await f.service.propose(f.project.id,{environmentId:'selected',modelId:'model'});
 expect((f.model.mock.calls[2]![0] as any).context.planningFeedback).toBeUndefined();
 await f.service.propose(f.project.id,{environmentId:'selected',modelId:'model',plan:f.plan});
 expect((f.model.mock.calls.at(-1)![0] as any).context.planningFeedback).toBeUndefined();
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
it('rechecks the binding after reading static artifact evidence and before asking for a verdict',async()=>{
 const f=fixture(),p=await f.approve();
 f.readArchive.mockImplementationOnce(async()=>{f.config.revision++;return {'SKILL.md':strToU8('Changed during artifact read')};});
 await f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest});
 expect((await f.finish()).status).not.toBe('PASSED');expect(f.model.mock.calls.some(c=>c[0].mode==='VERIFY')).toBe(false);await f.service.shutdown();
});
async function actualArchiveFixture(){
 const f=fixture(),root=await mkdtemp(path.join(os.tmpdir(),'reuse-archive-evidence-')),store=new SkillStore(root);
 await store.initialize();
 const files={'SKILL.md':'---\nname: evidence-fixture\ndescription: Read input and call the delivered script.\n---\nUse scripts/check.py.',
  'scripts/check.py':'import json,sys\nprint(json.dumps(json.load(sys.stdin)))\n',
  'scripts/check.js':'process.stdout.write("actual JS")',
  'assets/rules.json':'{"limit":150}'};
 const asset=await store.uploadZip(Buffer.from(zipSync({...Object.fromEntries(Object.entries(files).map(([name,text])=>[name,strToU8(text)])),
  'assets/binary.bin':Uint8Array.from([255,0,255])})));
 Object.assign(f.project.candidate!,asset);f.project.inspection!.reuseConformance!.candidateDigest=asset.artifactSha256;
 f.readArchive.mockImplementation(id=>store.readArchive(id));
 return {...f,root,store,files,asset};
}
it('supplies verified full Python/JS/resources to PLAN, COVERAGE and VERIFY, not the documentation-only projection',async()=>{
 const f=await actualArchiveFixture();expect(await f.store.readFiles(f.asset.assetId)).not.toHaveProperty('scripts/check.py');
 const approved=await f.approve();await f.service.start(f.project.id,{planId:approved.planId,inputDigest:approved.inputDigest});expect((await f.finish()).status).toBe('PASSED');
 for(const call of f.model.mock.calls){expect((call[0] as any).context).toMatchObject({candidateFiles:f.files,
   candidateFilePaths:[...Object.keys(f.files),'assets/binary.bin'].sort(),candidateBinaryPaths:['assets/binary.bin']});}
 expect(f.readArchive).toHaveBeenCalledTimes(2);await f.service.shutdown();
});
it('rejects altered archive bytes before proposing a plan',async()=>{
 const f=await actualArchiveFixture();await writeFile(path.join(f.root,'skills/assets',f.asset.assetId,'scripts/check.py'),'changed code');
 await expect(f.service.propose(f.project.id,{environmentId:'selected',modelId:'model'})).rejects.toThrow('快照摘要不一致');expect(f.model).not.toHaveBeenCalled();
});
it('does not let the final verdict read code altered after plan approval',async()=>{
 const f=await actualArchiveFixture(),approved=await f.approve();await writeFile(path.join(f.root,'skills/assets',f.asset.assetId,'scripts/check.py'),'changed after approval');
 await f.service.start(f.project.id,{planId:approved.planId,inputDigest:approved.inputDigest});expect((await f.finish()).status).not.toBe('PASSED');
 expect(f.model.mock.calls.some(call=>call[0].mode==='VERIFY')).toBe(false);await f.service.shutdown();
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
it.each(['fresh','repeated'] as const)('checks Launcher-scoped Script process receipts before the model verdict: %s',async kind=>{
 const f=fixture(),p=await f.approve(),original=f.execution.getMockImplementation()!;
 f.execution.mockImplementation(async()=>{const result=await original();for(const c of result.job.report.cases){
  const fact={tool:'lookup',status:'completed',argumentsDigest:'a'.repeat(64),resultDigest:'b'.repeat(64)};
  c.right.toolCalls=[{name:'lookup',status:'completed'}];c.right.metadata.toolEvidence=[fact];
  c.right.metadata.toolProcessEvidence={schemaVersion:'finance.runtime-tool-process-evidence.v1',scope:'LAUNCHER_MANAGED_SCRIPT_CALLS',
   caseScopeId:c.right.metadata.caseScopeId,records:[{...fact,callIndex:0,processScopeId:kind==='fresh'?`process-${c.caseId}`:'same-process',
    startedAt:'2026-10-11T08:00:00.000Z',exitedAt:'2026-10-11T08:00:01.000Z',exitCode:0}]};
  // The wire receipt contains only its strict fields, not a duplicated fact status.
  delete c.right.metadata.toolProcessEvidence.records[0].status;
 }return result;});
 await f.service.start(f.project.id,{planId:p.planId,inputDigest:p.inputDigest});const summary=await f.finish();
 expect(summary.status).toBe(kind==='fresh'?'PASSED':'INDETERMINATE');
 expect(f.model.mock.calls.some(c=>c[0].mode==='VERIFY')).toBe(kind==='fresh');await f.service.shutdown();
});
