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

it('admits only a trusted Builder Launcher, probes its lifecycle, recovers and reuses it',async()=>{
  const capabilities={schemaVersion:RUNTIME_CAPABILITIES_SCHEMA_VERSION,runtime:{type:'openjiuwen',version:'1.0.0'},models:[{modelId:'execution',upstreamModelId:'glm-4-plus'}],defaultModelId:'execution',
    observability:{schemaVersion:'finance.runtime-observation-capabilities.v1' as const,profile:'core' as const,supportedKinds:['execution.started','execution.completed','execution.failed'] as const,nativeEvents:false,replayable:false},
    features:{streaming:true,asyncLaunch:true,packagedMcp:true,externalMcp:false,inlineSecrets:true},limits:{maxArchiveBytes:1,maxFiles:1,maxTimeoutMs:300000,maxConcurrentInstances:1}};
  const lifecycle:string[]=[],authorizations:Array<string|undefined>=[];let instanceRunId='';
  const server=Fastify();server.addHook('onRequest',async request=>{authorizations.push(request.headers.authorization);});server.get('/v1/runtime-capabilities',()=>capabilities);
  server.post('/v1/runtime-instances',request=>{lifecycle.push('create');const body=request.body as {runId:string;side:'right';modelId:string};instanceRunId=body.runId;return {schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:'probe-instance',status:'ready',executeEndpoint:'/v1/runtime-instances/probe-instance/execute',expiresAt:new Date(Date.now()+60_000).toISOString(),error:null,configurationDigest:'probe-config'};});
  server.get('/v1/runtime-instances/probe-instance',()=>{lifecycle.push('status');return {schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:'probe-instance',status:'ready',executeEndpoint:'/v1/runtime-instances/probe-instance/execute',expiresAt:new Date(Date.now()+60_000).toISOString(),error:null,configurationDigest:'probe-config'};});
  server.post('/v1/runtime-instances/probe-instance/execute',request=>{lifecycle.push('execute');const body=request.body as {caseId:string;workspaceFiles:Array<{path:string;content:string}>};return {runId:instanceRunId,caseId:body.caseId,side:'right',modelId:'execution',skillVersion:null,status:'completed',output:'CONFORMANCE_OK',elapsedMs:1,toolCalls:[],loadedSkills:[],usage:null,runtimeIdentityVerified:true,streamCompleted:true,error:null,metadata:{instanceConfigurationDigest:'probe-config',workspaceFilesDigest:workspaceFilesDigest(body.workspaceFiles)}};});
  server.delete('/v1/runtime-instances/probe-instance',(_request,reply)=>{lifecycle.push('delete');return reply.code(204).send();});
  await server.listen({host:'127.0.0.1',port:0});cleanup.push(()=>server.close());
  const address=server.server.address();if(!address||typeof address==='string')throw new Error('Missing test server address');
  const protocols={capabilities:RUNTIME_CAPABILITIES_SCHEMA_VERSION,instance:RUNTIME_INSTANCE_SCHEMA_VERSION,execution:RUNTIME_EXECUTION_SCHEMA_VERSION,observation:RUNTIME_OBSERVATION_SCHEMA_VERSION};
  const requirement={id:'harness-1',name:'read_document',required:true,reason:'read workspace data',contract:{inputSchema:{type:'object'},outputSchema:{type:'object'},errorSchema:{type:'object'},semantics:'workspace only'},constraints:{permissions:['workspace.read'],sideEffects:'read' as const,isolation:'per_instance'},preferredTargetCapability:null,consumerTools:['review'],evidence:[{path:'tool.py',line:1,detail:'call'}]};
  const requirements=withRequirementsDigest({schemaVersion:'finance.runtime-build-requirements.v1',requestId:'request-1',source:{assetId:'asset-1',artifactSha256:'a'.repeat(64)},target:{runtimeType:'openjiuwen',protocols},requiredCapabilities:[requirement]});
  const launcher={schemaVersion:'finance.runtime-launcher-descriptor.v1' as const,deploymentId:'deployment-1',baseUrl:`http://127.0.0.1:${address.port}/`,runtime:capabilities.runtime,protocols,authentication:{type:'bearer' as const},artifactSha256:'b'.repeat(64),capabilitiesDigest:canonicalSha256(capabilities),expiresAt:null};
  const result=withResultDigest({schemaVersion:'finance.runtime-build-result.v1',buildId:'build-1',requestId:requirements.requestId,requirementsDigest:requirements.requirementsDigest,status:'SUCCEEDED',builder:{name:'finance-solution-builder',version:'0.1.0'},launcher,
    capabilityResults:[{requirementId:requirement.id,status:'IMPLEMENTED',capabilityId:'workspace.read_document',contractDigest:canonicalSha256(requirement.contract),verificationIds:['verify-1']}],verifications:[{id:'verify-1',type:'CONTRACT_TEST',status:'PASSED',evidenceSha256:'c'.repeat(64)}],errors:[],builtAt:new Date().toISOString()});
  const directory=await mkdtemp(path.join(tmpdir(),'finance-builder-intake-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  vi.stubEnv('BUILDER_TEST_TOKEN','builder-only');vi.stubEnv('FINANCE_EVAL_MODEL_API_KEY','must-not-leak');
  const store=new EnvironmentStore(directory,[{reference:'builder-local',label:'Builder local',baseUrlPrefix:`http://127.0.0.1:${address.port}/`,credentialEnv:'BUILDER_TEST_TOKEN'}]);await store.initialize();
  await expect(store.acceptBuilderDelivery({trustReference:'unknown-target',requirements,result})).rejects.toThrow(/信任引用/u);
  const {resultDigest:_,...resultBody}=result;
  const untrusted=withResultDigest({...resultBody,launcher:{...launcher,baseUrl:'http://127.0.0.1:9/'}});
  await expect(store.acceptBuilderDelivery({trustReference:'builder-local',requirements,result:untrusted})).rejects.toThrow(/不属于信任引用/u);
  expect(lifecycle).toEqual([]);
  expect(authorizations).toEqual([]);
  const first=await store.acceptBuilderDelivery({trustReference:'builder-local',requirements,result});
  await store.rollbackBuilderDelivery(first.environment.environmentId,result.resultDigest);
  expect(await store.list()).toEqual([]);
  const recovered=await store.acceptBuilderDelivery({trustReference:'builder-local',requirements,result});
  const second=await store.acceptBuilderDelivery({trustReference:'builder-local',requirements,result});
  expect(second.environment.environmentId).toBe(recovered.environment.environmentId);
  expect(recovered.environment).toMatchObject({type:'runtime_launcher',runtimeType:'openjiuwen',delivery:{buildId:'build-1',deploymentId:'deployment-1',evalConformance:{status:'PASSED',checks:['capabilities','create','status','execute','evidence','delete']}}});
  expect(await store.list()).toHaveLength(1);
  expect(lifecycle).toEqual(['create','status','execute','delete','create','status','execute','delete','create','status','execute','delete']);
  expect(new Set(authorizations)).toEqual(new Set(['Bearer builder-only']));
});
