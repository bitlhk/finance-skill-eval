import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {afterEach,expect,it} from 'vitest';
import {EnvironmentStore} from '../src/service/environment-store.js';
import {canonicalSha256} from '../src/shared/json-canonicalization.js';
import {withRequirementsDigest,withResultDigest} from '../src/shared/contracts/runtime-builder.js';
import {RUNTIME_CAPABILITIES_SCHEMA_VERSION,RUNTIME_EXECUTION_SCHEMA_VERSION,RUNTIME_INSTANCE_SCHEMA_VERSION,RUNTIME_OBSERVATION_SCHEMA_VERSION} from '../src/shared/contracts/runtime-protocol-versions.js';

const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{while(cleanup.length)await cleanup.pop()!();});

it('verifies, registers and idempotently reuses a Builder-delivered Launcher',async()=>{
  const capabilities={schemaVersion:RUNTIME_CAPABILITIES_SCHEMA_VERSION,runtime:{type:'openjiuwen',version:'1.0.0'},models:[{modelId:'execution',upstreamModelId:'glm-4-plus'}],defaultModelId:'execution',
    observability:{schemaVersion:'finance.runtime-observation-capabilities.v1' as const,profile:'core' as const,supportedKinds:['execution.started','execution.completed','execution.failed'] as const,nativeEvents:false,replayable:false},
    features:{streaming:true,asyncLaunch:true,packagedMcp:true,externalMcp:false,inlineSecrets:true},limits:{maxArchiveBytes:1,maxFiles:1,maxTimeoutMs:300000,maxConcurrentInstances:1}};
  const server=Fastify();server.get('/v1/runtime-capabilities',()=>capabilities);await server.listen({host:'127.0.0.1',port:0});cleanup.push(()=>server.close());
  const address=server.server.address();if(!address||typeof address==='string')throw new Error('Missing test server address');
  const protocols={capabilities:RUNTIME_CAPABILITIES_SCHEMA_VERSION,instance:RUNTIME_INSTANCE_SCHEMA_VERSION,execution:RUNTIME_EXECUTION_SCHEMA_VERSION,observation:RUNTIME_OBSERVATION_SCHEMA_VERSION};
  const requirement={id:'harness-1',name:'read_document',required:true,reason:'read workspace data',contract:{inputSchema:{type:'object'},outputSchema:{type:'object'},errorSchema:{type:'object'},semantics:'workspace only'},constraints:{permissions:['workspace.read'],sideEffects:'read' as const,isolation:'per_instance'},preferredTargetCapability:null,consumerTools:['review'],evidence:[{path:'tool.py',line:1,detail:'call'}]};
  const requirements=withRequirementsDigest({schemaVersion:'finance.runtime-build-requirements.v1',requestId:'request-1',source:{assetId:'asset-1',artifactSha256:'a'.repeat(64)},target:{runtimeType:'openjiuwen',protocols},requiredCapabilities:[requirement]});
  const launcher={schemaVersion:'finance.runtime-launcher-descriptor.v1' as const,deploymentId:'deployment-1',baseUrl:`http://127.0.0.1:${address.port}/`,runtime:capabilities.runtime,protocols,authentication:{type:'none' as const},artifactSha256:'b'.repeat(64),capabilitiesDigest:canonicalSha256(capabilities),expiresAt:null};
  const result=withResultDigest({schemaVersion:'finance.runtime-build-result.v1',buildId:'build-1',requestId:requirements.requestId,requirementsDigest:requirements.requirementsDigest,status:'SUCCEEDED',builder:{name:'finance-solution-builder',version:'0.1.0'},launcher,
    capabilityResults:[{requirementId:requirement.id,status:'IMPLEMENTED',capabilityId:'workspace.read_document',contractDigest:canonicalSha256(requirement.contract),verificationIds:['verify-1']}],verifications:[{id:'verify-1',type:'CONTRACT_TEST',status:'PASSED',evidenceSha256:'c'.repeat(64)}],errors:[],builtAt:new Date().toISOString()});
  const directory=await mkdtemp(path.join(tmpdir(),'finance-builder-intake-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  const store=new EnvironmentStore(directory);await store.initialize();
  const first=await store.acceptBuilderDelivery({migrationId:'migration-1',requirements,result});
  const second=await store.acceptBuilderDelivery({migrationId:'migration-1',requirements,result});
  expect(second.environment.environmentId).toBe(first.environment.environmentId);
  expect(first.environment).toMatchObject({type:'runtime_launcher',runtimeType:'openjiuwen',delivery:{buildId:'build-1',deploymentId:'deployment-1'}});
  expect(await store.list()).toHaveLength(1);
});
