import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {afterEach,expect,it,vi} from 'vitest';
import {EnvironmentStore} from '../src/service/environment-store.js';
import {canonicalSha256} from '../src/shared/json-canonicalization.js';
import {workspaceFilesDigest} from '../src/contracts.js';
import {withRequirementsDigest,withResultDigest} from '../src/shared/contracts/runtime-builder.js';
import {RUNTIME_CAPABILITIES_SCHEMA_VERSION,RUNTIME_EXECUTION_SCHEMA_VERSION,RUNTIME_INSTANCE_SCHEMA_VERSION,RUNTIME_OBSERVATION_SCHEMA_VERSION} from '../src/shared/contracts/runtime-protocol-versions.js';

const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{while(cleanup.length)await cleanup.pop()!();vi.unstubAllEnvs();});

it.each(['file','managed','managed-tools','managed-minimum','managed-missingminimum','managed-undeclared','managed-marker','managed-mapping','managed-tool','managed-members','managed-cleanup'])('admits only a trusted Builder Launcher and verifies lifecycle: %s',async mode=>{
  const managed=mode.startsWith('managed'),fault=mode==='managed-tools'?undefined:mode.split('-')[1];
  const mounted=mode==='managed-tools'?['read_document']:[];
  const checks=['capabilities','create','status','execute','evidence','delete'];
  const capabilities={schemaVersion:RUNTIME_CAPABILITIES_SCHEMA_VERSION,instanceSchemaVersion:RUNTIME_INSTANCE_SCHEMA_VERSION,platform:{os:'linux',arch:'x64',isolation:'trusted_local_process'},nativeToolNames:managed?['read_document']:['read_file','read_document'],runtime:{type:'openjiuwen',version:'1.0.0'},models:[{modelId:'execution',upstreamModelId:'glm-4-plus'}],defaultModelId:'execution',
    observability:{schemaVersion:'finance.runtime-observation-capabilities.v1' as const,profile:'core' as const,supportedKinds:['execution.started','execution.completed','execution.failed'] as const,nativeEvents:false,replayable:false},
    features:{streaming:true,asyncLaunch:true,packagedMcp:true,externalMcp:false,inlineSecrets:true,...(managed&&fault!=='undeclared'?{managedMethodProbe:true}:{})},limits:{maxSkills:10,maxArchiveBytes:8388608,maxFiles:1000,maxTimeoutMs:300000,maxConcurrentInstances:1,...(fault==='missingminimum'?{}:{minPrimaryTools:fault==='minimum'?2:mounted.length})}};
  const lifecycle:string[]=[],authorizations:Array<string|undefined>=[];let instanceRunId='';let created:any;
  const server=Fastify();server.addHook('onRequest',async request=>{authorizations.push(request.headers.authorization);});server.get('/v1/runtime-capabilities',()=>capabilities);
  server.post('/v1/runtime-instances',request=>{lifecycle.push('create');const body=request.body as {runId:string;side:'right';modelId:string};instanceRunId=body.runId;created=body;return {schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:'probe-instance',status:'ready',executeEndpoint:'/v1/runtime-instances/probe-instance/execute',expiresAt:new Date(Date.now()+60_000).toISOString(),error:null,configurationDigest:'probe-config'};});
  server.get('/v1/runtime-instances/probe-instance',()=>{lifecycle.push('status');return {schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:'probe-instance',status:'ready',executeEndpoint:'/v1/runtime-instances/probe-instance/execute',expiresAt:new Date(Date.now()+60_000).toISOString(),error:null,configurationDigest:'probe-config'};});
  server.post('/v1/runtime-instances/probe-instance/execute',request=>{
    lifecycle.push('execute');
    const body=request.body as {caseId:string;query:string;requiredTools:string[];workspaceFiles:Array<{path:string;content:string}>};
    const marker=managed?created.skills[0].instructions.match(/RUNTIME_PROBE_[a-f0-9-]+/u)[0]:body.workspaceFiles[0]!.content;
    if(managed){expect(body.query).not.toContain(marker);expect(body.workspaceFiles).toEqual([]);expect(body.requiredTools).toEqual([]);expect(created.environment.requiredToolNames).toEqual(mounted);expect(created.skills[0].instructions).toContain(`allowed-tools: ${JSON.stringify(mounted)}`);}
    return {runId:instanceRunId,caseId:body.caseId,side:'right',modelId:'execution',skillVersion:null,status:'completed',output:fault==='marker'?'wrong':marker,elapsedMs:1,toolCalls:!managed||fault==='tool'?[{name:'read_file',status:'completed'}]:[],loadedSkills:created.skills.map((m:any)=>({skillId:m.skillId,version:m.version})),usage:null,runtimeIdentityVerified:true,streamCompleted:true,error:null,metadata:{contentDigest:created.contentDigest,loadedSkillMembers:fault==='members'?[]:created.skills.map(({instructions,files,...m}:any)=>m),instanceConfigurationDigest:'probe-config',workspaceFilesDigest:body.workspaceFiles.length?workspaceFilesDigest(body.workspaceFiles):null,...(managed&&fault!=='mapping'?{skillSetInstallation:'COMPILED_INTO_MANAGED_METHOD'}:{})}};
  });
  server.delete('/v1/runtime-instances/probe-instance',()=>{lifecycle.push('delete');return {cleanup:{schemaVersion:'finance.eval-cleanup-observation.v1',instanceId:'probe-instance',observedAt:new Date().toISOString(),status:fault==='cleanup'?'FAILED':'RELEASED',scope:'THIS_INSTANCE'}};});
  await server.listen({host:'127.0.0.1',port:0});cleanup.push(()=>server.close());
  const address=server.server.address();if(!address||typeof address==='string')throw new Error('Missing test server address');
  const protocols={capabilities:RUNTIME_CAPABILITIES_SCHEMA_VERSION,instance:RUNTIME_INSTANCE_SCHEMA_VERSION,execution:RUNTIME_EXECUTION_SCHEMA_VERSION,observation:RUNTIME_OBSERVATION_SCHEMA_VERSION};
  const requirement={id:'harness-1',name:'read_document',required:true,reason:'read workspace data',contract:{inputSchema:{type:'object'},outputSchema:{type:'object'},errorSchema:{type:'object'},semantics:'workspace only'},constraints:{permissions:['workspace.read'],sideEffects:'read' as const,isolation:'per_instance'},preferredTargetCapability:null,consumerTools:['review'],evidence:[{path:'tool.py',line:1,detail:'call'}]};
  const requirements=withRequirementsDigest({schemaVersion:'finance.runtime-build-requirements.v3',requestId:'request-1',executionRequirements:{platform:capabilities.platform,features:['streaming'],limits:{maxSkills:1,maxFiles:1,maxArchiveBytes:1024,maxTimeoutMs:300000}},target:{runtimeType:'openjiuwen',protocols},requiredCapabilities:[requirement]});
  Object.assign(capabilities,{nativeCapabilities:[{capabilityId:'workspace.read_document',name:'read_document',contract:requirement.contract,constraints:requirement.constraints}]});
  const launcher={schemaVersion:'finance.runtime-launcher-descriptor.v2' as const,deploymentId:'deployment-1',baseUrl:`http://127.0.0.1:${address.port}/`,runtime:capabilities.runtime,protocols,authentication:{type:'bearer' as const},artifactSha256:'b'.repeat(64),capabilitiesDigest:canonicalSha256(capabilities),expiresAt:null};
  const result=withResultDigest({schemaVersion:'finance.runtime-build-result.v3',buildId:'build-1',requestId:requirements.requestId,requirementsDigest:requirements.requirementsDigest,status:'SUCCEEDED',builder:{name:'finance-solution-builder',version:'0.1.0'},launcher,
    capabilityResults:[{requirementId:requirement.id,status:'IMPLEMENTED',capabilityId:'workspace.read_document',contractDigest:canonicalSha256(requirement.contract),verificationIds:['verify-1']}],verifications:[{id:'lifecycle',type:'RUNTIME_LIFECYCLE',status:'PASSED',evidenceSha256:'f'.repeat(64)},{id:'verify-1',type:'CONTRACT_TEST',status:'PASSED',evidenceSha256:'c'.repeat(64)}],errors:[],builtAt:new Date().toISOString()});
  const directory=await mkdtemp(path.join(tmpdir(),'finance-builder-intake-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  vi.stubEnv('BUILDER_TEST_TOKEN','builder-only');vi.stubEnv('FINANCE_EVAL_MODEL_API_KEY','must-not-leak');
  const store=new EnvironmentStore(directory,[{reference:'builder-local',label:'Builder local',baseUrlPrefix:`http://127.0.0.1:${address.port}/`,credentialEnv:'BUILDER_TEST_TOKEN'}]);await store.initialize();
  await expect(store.acceptBuilderDelivery({trustReference:'unknown-target',requirements,result})).rejects.toThrow(/信任引用/u);
  const {resultDigest:_,...resultBody}=result;
  const untrusted=withResultDigest({...resultBody,launcher:{...launcher,baseUrl:'http://127.0.0.1:9/'}});
  await expect(store.acceptBuilderDelivery({trustReference:'builder-local',requirements,result:untrusted})).rejects.toThrow(/不属于信任引用/u);
  expect(lifecycle).toEqual([]);
  expect(authorizations).toEqual([]);
  if(fault){
    const reason=fault==='minimum'||fault==='missingminimum'?/tool minimum/u:fault==='undeclared'?/no declared supported/u:fault==='members'?/整组 Skill/u:fault==='cleanup'?/清理失败/u:fault==='marker'?/did not return/u:/Managed method probe/u;
    await expect(store.acceptBuilderDelivery({trustReference:'builder-local',requirements,result})).rejects.toThrow(reason);
    expect(await store.list()).toEqual([]);
    expect(lifecycle).toEqual(['undeclared','minimum','missingminimum'].includes(fault)?[]:['create','status','execute','delete']);
    return;
  }
  const first=await store.acceptBuilderDelivery({trustReference:'builder-local',requirements,result});
  expect(first.environment.delivery?.evalConformance.probeKind).toBe(managed?'MANAGED_METHOD_INSTRUCTION_NONCE':'WORKSPACE_FILE_READ');
  await store.rollbackBuilderDelivery(first.environment.environmentId,result.resultDigest);
  expect(await store.list()).toEqual([]);
  const recovered=await store.acceptBuilderDelivery({trustReference:'builder-local',requirements,result});
  await expect(store.update(recovered.environment.environmentId,{name:'Changed',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:'http://127.0.0.1:9/'})).rejects.toMatchObject({statusCode:409});
  await expect(store.update(recovered.environment.environmentId,{name:'Changed',type:'runtime_launcher',runtimeType:'generic_http',baseUrl:recovered.environment.baseUrl})).rejects.toMatchObject({statusCode:409});
  await expect(store.update(recovered.environment.environmentId,{name:'Changed',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:recovered.environment.baseUrl,credentialEnv:'OTHER_TOKEN'})).rejects.toMatchObject({statusCode:409});
  await expect(store.update(recovered.environment.environmentId,{name:'Renamed',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:recovered.environment.baseUrl})).resolves.toMatchObject({name:'Renamed',delivery:{evalConformance:{status:'PASSED'}}});
  const second=await store.acceptBuilderDelivery({trustReference:'builder-local',requirements,result});
  expect(second.environment.environmentId).toBe(recovered.environment.environmentId);
  expect(recovered.environment).toMatchObject({type:'runtime_launcher',runtimeType:'openjiuwen',delivery:{buildId:'build-1',deploymentId:'deployment-1',evalConformance:{status:'PASSED',checks}}});
  expect(await store.list()).toHaveLength(1);
  expect(lifecycle).toEqual(['create','status','execute','delete','create','status','execute','delete','create','status','execute','delete']);
  expect(new Set(authorizations)).toEqual(new Set(['Bearer builder-only']));
});
