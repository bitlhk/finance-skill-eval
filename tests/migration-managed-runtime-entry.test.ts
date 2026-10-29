import { standardExecutionRequirements } from './runtime-standard-fixture.js';
import {expect,it,vi} from 'vitest';
import {inspectionFixture} from './analysis-fixture.js';
import type {MigrationProject} from '../src/migration/domain/migration-project.js';
import {resolveManagedMigrationEnvironment,type MigrationLauncher} from '../src/migration/application/migration-environment-repository.js';
import {MigrationOpenJiuwenService} from '../src/migration/application/migration-openjiuwen-service.js';
import {MigrationReportService} from '../src/migration/application/migration-report-service.js';
import {runtimeBuildRequirements} from '../src/migration/domain/migration-harness.js';
import {unresolvedMigrationRuntimeRequirements} from '../src/migration/application/migration-runtime-requirements.js';
import {MigrationPlanningService} from '../src/migration/application/migration-planning-service.js';

function project():MigrationProject {
  const inspection=inspectionFixture([]);
  const asset={assetId:'asset',artifactSha256:inspection.assetDigest,skillId:'skill',version:'1.0.0'};
  return {runtimeExecutionRequirements:standardExecutionRequirements,id:'migration-1',source:asset,candidate:asset,inspection,sourceInspection:inspection,
    runs:[],candidateNotes:'',assessment:'NOT_VALIDATED',createdAt:new Date().toISOString(),name:'test',
    schemaVersion:'finance.skill-migration.v2'} as MigrationProject;
}

function launcher(runtimeType:MigrationLauncher['runtimeType']='openjiuwen'):MigrationLauncher {
  return {environmentId:'env-runtime',type:'runtime_launcher',runtimeType,name:'managed',
    baseUrl:'http://127.0.0.1:1234/',credentialEnv:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
}

function addRequirement(value:MigrationProject) {
  value.sourceInspection!.runtimeCapabilities=[{name:'read_document',owner:'RUNTIME_HARNESS',migrationAction:'REQUIRES_RUNTIME_BUILDER',blocking:true,
    reason:'Runtime-owned read',usageContract:'Read only workspace files',targetCapability:null,
    contract:{inputSchema:{type:'object'},outputSchema:{type:'object'},errorSchema:{type:'object'},semantics:'Workspace only'},
    constraints:{permissions:['workspace.read'],sideEffects:'read',isolation:'per_runtime_instance'},
    testAvailability:'UNCHECKED',consumerTools:[],evidence:[]}];
}

function deliver(value:MigrationProject,environment:MigrationLauncher) {
  const requirements=runtimeBuildRequirements(value.sourceInspection!,{runtimeType:environment.runtimeType,executionRequirements:value.runtimeExecutionRequirements});
  if(!requirements||!('requestId' in requirements))throw new Error('fixture requirements incomplete');
  const delivery={schemaVersion:'finance.runtime-launcher-delivery-record.v1' as const,
    requestId:requirements.requestId,requirementsDigest:requirements.requirementsDigest,
    buildId:'build',deploymentId:'deployment',artifactSha256:'a'.repeat(64),capabilitiesDigest:'b'.repeat(64),resultDigest:'c'.repeat(64),
    builder:{name:'trusted',version:'1'},acceptedAt:new Date().toISOString(),expiresAt:null,
    evalConformance:{runId:'conformance-test',instanceSchemaVersion:'finance.runtime-instance.v1' as const,probeDigest:'d'.repeat(64),status:'PASSED' as const,testedAt:new Date().toISOString(),checks:['capabilities','create','status','execute','evidence','delete'] as ['capabilities','create','status','execute','evidence','delete']}};
  environment.delivery=delivery;
  value.runtimeDelivery={...delivery,environmentId:environment.environmentId};
  return delivery;
}

function services(value:MigrationProject,environment:MigrationLauncher,ready=true,archive:Record<string,Uint8Array>={}) {
  const projects={get:vi.fn(async()=>value)};
  const configs={get:vi.fn(async()=>({revision:0,values:{},checks:[]}))};
  const repo={get:vi.fn(async(id:string)=>id===environment.environmentId?environment:null)};
  const evaluate=vi.fn(async(_id:string,body:unknown)=>body);
  const report=new MigrationReportService(projects as never,{get:()=>null} as never,undefined,undefined,undefined,repo,configs as never);
  const entry=new MigrationOpenJiuwenService(projects as never,{readArchive:async()=>archive} as never,
    {currentState:async()=>({ready,reasons:['technical validation missing']})} as never,
    {validate:evaluate} as never,report,{resolve:vi.fn()} as never,repo,configs as never);
  return {entry,report,evaluate,repo};
}

it.each(['openjiuwen','agentscope'] as const)('admits registered %s Launchers without bypassing technical validation',async type=>{
  const value=project(),environment=launcher(type),{entry,evaluate}=services(value,environment);
  const result=await entry.validate(value.id,{configuration:{runtime:{type:'runtime_launcher',environmentId:environment.environmentId}}});
  expect(result).toMatchObject({configuration:{runtimeCommandBindings:{left:[],right:[]},runtimeMcpBindings:{left:[],right:[]}}});
  expect(evaluate).toHaveBeenCalledOnce();
  const blocked=services(value,environment,false);
  await expect(blocked.entry.validate(value.id,{configuration:{runtime:{type:'runtime_launcher',environmentId:environment.environmentId}}})).rejects.toThrow('technical validation missing');
  expect(blocked.evaluate).not.toHaveBeenCalled();
});

it('mounts Script sibling resources without extension filtering or pulling an external MCP service into its Skill',async()=>{
 const value=project(),environment=launcher();
 Object.assign(value.candidate!,{skillFile:'skill/SKILL.md'});
 value.inspection!.tools=[{name:'expense',kind:'SCRIPT',entrypoint:{kind:'PYTHON',path:'skill/scripts/expense.py'}}] as never;
 const archive=Object.fromEntries(['skill/SKILL.md','skill/scripts/expense.py','skill/scripts/pyproject.toml','skill/assets/rules.json','skill/assets/data.csv','skill/references/rules.txt','mcp/server.py']
  .map(path=>[path,new TextEncoder().encode('fixture')]));
 const {entry}=services(value,environment,true,archive);
 const result=await entry.validate(value.id,{configuration:{runtime:{type:'runtime_launcher',environmentId:environment.environmentId}}}) as any;
 expect(result.configuration.runtimeCommandBindings.right[0].filePaths).toEqual(Object.keys(archive).filter(path=>path.startsWith('skill/')));
});

it.each([
  ['ready','agentscope','2.0.3',true],['ready','openjiuwen','0.1.15',true],
  ['ready','agentscope','unknown',false],['ready','ea','2.0.3',true],['failed','agentscope','2.0.3',false],
] as const)('legacy generic requires capabilities proof: %s/%s/%s',async(status,type,version,allowed)=>{
  const environment=launcher('generic_http');
  const repo={get:async()=>environment,preflight:vi.fn(async()=>({status,capabilities:{runtime:{type,version}}}))};
  expect(Boolean(await resolveManagedMigrationEnvironment(repo,environment.environmentId))).toBe(allowed);
  expect(await resolveManagedMigrationEnvironment({get:repo.get},environment.environmentId)).toBeNull();
});

it('checks both CC environments before forwarding without rewriting the comparison plan',async()=>{
  const value=project(),oj=launcher(),as={...launcher('agentscope'),environmentId:'env-as'};
  const {entry,repo,evaluate}=services(value,oj);
  repo.get.mockImplementation(async id=>id===oj.environmentId?oj:id===as.environmentId?as:null);
  const body={pair:'CC',configuration:{runtime:{type:'runtime_launcher',environmentId:oj.environmentId},
    runtimeBindings:{left:{environmentId:oj.environmentId},right:{environmentId:as.environmentId}},
    executionModel:{parameters:{temperature:0.25,top_p:0.8,max_tokens:1234}}}};
  expect(await entry.validate(value.id,body)).toMatchObject(body);
  evaluate.mockClear();
  as.archived=true;
  await expect(entry.validate(value.id,body)).rejects.toThrow('OpenJiuwen 或 AgentScope');
  expect(evaluate).not.toHaveBeenCalled();
});

it.each(['openjiuwen','agentscope'] as const)('uses the same digest-backed %s delivery decision for reporting and execution',async type=>{
  const value=project(),environment=launcher(type);addRequirement(value);deliver(value,environment);
  const {entry,report,evaluate}=services(value,environment);
  expect((await report.report(value.id)).runtimeRequirements).toBeNull();
  await entry.validate(value.id,{configuration:{runtime:{type:'runtime_launcher',environmentId:environment.environmentId}}});
  expect(evaluate).toHaveBeenCalledOnce();
});

it('does not borrow an OJ delivery to satisfy the AS side of CC',async()=>{
  const value=project(),oj=launcher(),as={...launcher('agentscope'),environmentId:'env-as'};
  addRequirement(value);deliver(value,oj);
  const {entry,repo,evaluate}=services(value,oj);
  repo.get.mockImplementation(async id=>id===oj.environmentId?oj:id===as.environmentId?as:null);
  await expect(entry.validate(value.id,{pair:'CC',configuration:{
    runtime:{type:'runtime_launcher',environmentId:oj.environmentId},
    runtimeBindings:{left:{environmentId:oj.environmentId},right:{environmentId:as.environmentId}},
  }})).rejects.toThrow('Runtime 能力缺口');
  expect(evaluate).not.toHaveBeenCalled();
});

it('retains independent deliveries for both CC targets and rejects drift on either side',async()=>{
  const value=project(),oj=launcher(),as={...launcher('agentscope'),environmentId:'env-as'};
  addRequirement(value);deliver(value,oj);
  const ojBinding=value.runtimeDelivery!;
  deliver(value,as);
  value.runtimeDeliveries={[oj.environmentId]:ojBinding,[as.environmentId]:value.runtimeDelivery!};
  const {entry,repo,evaluate}=services(value,oj);
  repo.get.mockImplementation(async id=>id===oj.environmentId?oj:id===as.environmentId?as:null);
  const body={pair:'CC',configuration:{runtime:{type:'runtime_launcher',environmentId:oj.environmentId},
    runtimeBindings:{left:{environmentId:oj.environmentId},right:{environmentId:as.environmentId}}}};
  await entry.validate(value.id,body);
  expect(evaluate).toHaveBeenCalledOnce();
  evaluate.mockClear();
  as.delivery!.resultDigest='f'.repeat(64);
  await expect(entry.validate(value.id,body)).rejects.toThrow('Runtime 能力缺口');
  expect(evaluate).not.toHaveBeenCalled();
});

it('persists both deliveries while retaining the legacy latest binding',async()=>{
  const value=project(),oj=launcher(),as={...launcher('agentscope'),environmentId:'env-as'};
  addRequirement(value);deliver(value,oj);
  const first=structuredClone(value.runtimeDelivery!);
  deliver(value,as);
  const second=structuredClone(value.runtimeDelivery!);
  value.runtimeDelivery=first;
  let saved=structuredClone(value);
  const projects={get:async()=>structuredClone(saved),save:async(next:MigrationProject)=>{saved=structuredClone(next)},
    runExclusive:async(_id:string,action:()=>Promise<unknown>)=>action()};
  const service=new MigrationPlanningService(projects as never,{serialize:()=>null});
  await service.bindRuntimeDelivery(value.id,second);
  expect(saved.runtimeDeliveries).toEqual({[oj.environmentId]:first,[as.environmentId]:second});
  expect(saved.runtimeDelivery).toEqual(second);
  await service.bindRuntimeDelivery(value.id,first);
  expect(saved.runtimeDeliveries).toEqual({[oj.environmentId]:first,[as.environmentId]:second});
  expect(saved.runtimeDelivery).toEqual(first);
});

it.each(['missing-digest','expired','wrong-digest','wrong-request','record-drift','missing-environment','incomplete-contract','changed-contract','conformance'])(
  'keeps Runtime gaps blocked in both paths: %s',async mutation=>{
    const value=project(),environment=launcher();addRequirement(value);deliver(value,environment);
    if(mutation==='missing-digest')delete (value.runtimeDelivery as unknown as Record<string,unknown>).requirementsDigest;
    if(mutation==='expired'){
      value.runtimeDelivery!.expiresAt='2000-01-01T00:00:00.000Z';environment.delivery!.expiresAt=value.runtimeDelivery!.expiresAt;
    }
    if(mutation==='wrong-digest'){
      Object.assign(value.runtimeDelivery!,{requirementsDigest:'f'.repeat(64)});Object.assign(environment.delivery!,{requirementsDigest:'f'.repeat(64)});
    }
    if(mutation==='wrong-request')value.runtimeDelivery!.requestId='other';
    if(mutation==='record-drift')environment.delivery!.resultDigest='e'.repeat(64);
    if(mutation==='missing-environment')value.runtimeDelivery!.environmentId='missing';
    if(mutation==='incomplete-contract')delete value.sourceInspection!.runtimeCapabilities![0]!.contract;
    if(mutation==='changed-contract')value.sourceInspection!.runtimeCapabilities![0]!.contract!.semantics='Different permissions required';
    if(mutation==='conformance')Object.assign(environment.delivery!.evalConformance,{status:'FAILED'});
    const {entry,report,evaluate}=services(value,environment);
    expect((await report.report(value.id)).runtimeRequirements).not.toBeNull();
    await expect(entry.validate(value.id,{configuration:{runtime:{type:'runtime_launcher',environmentId:environment.environmentId}}})).rejects.toThrow('Runtime 能力缺口');
    expect(evaluate).not.toHaveBeenCalled();
  });

it('does not discharge a gap with a different selected Launcher, but resolves an execution-environment alias',async()=>{
  const value=project(),environment=launcher();addRequirement(value);deliver(value,environment);
  const repo={get:async(id:string)=>id===environment.environmentId?environment:null};
  const other={...environment,environmentId:'other'};
  expect(await unresolvedMigrationRuntimeRequirements(value,repo,{selected:other,launcher:other})).not.toBeNull();
  expect(await unresolvedMigrationRuntimeRequirements(value,repo,{selected:{type:'execution_environment',environmentId:'alias',
    name:'alias',runtimeType:null,launcherEnvironmentId:environment.environmentId,mcpEnvironmentIds:[],defaultModelId:null,createdAt:'now',updatedAt:'now'},launcher:environment})).toBeNull();
});

it('does not let caller-supplied delivery metadata or a noncompliant Skill unlock execution',async()=>{
  const value=project(),environment=launcher();addRequirement(value);
  const {entry,evaluate}=services(value,environment);
  await expect(entry.validate(value.id,{runtimeDelivery:{requestId:'fake'},configuration:{runtime:{type:'runtime_launcher',environmentId:environment.environmentId}}})).rejects.toThrow('Runtime 能力缺口');
  value.inspection!.skill.status='NON_COMPLIANT';
  await expect(entry.validate(value.id,{configuration:{runtime:{type:'runtime_launcher',environmentId:environment.environmentId}}})).rejects.toThrow('企业规范');
  expect(evaluate).not.toHaveBeenCalled();
});

it('reports AgentScope experiments through the legacy compatibility field',async()=>{
  const value=project(),environment=launcher('agentscope');
  value.runs.push({jobId:'job',pair:'BC',candidateDigest:value.candidate!.artifactSha256,comparisonFingerprint:'x',packFingerprint:'x',
    declaredPlan:{configuration:{runtime:{type:'runtime_launcher',environmentId:environment.environmentId}}} as never});
  const {report}=services(value,environment);
  expect((await report.report(value.id)).openJiuwenValidations).toMatchObject([{jobId:'job',environmentId:environment.environmentId,execution:'MISSING'}]);
});
