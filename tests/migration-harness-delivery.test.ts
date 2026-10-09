import {expect,it} from 'vitest';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {strToU8,zipSync} from 'fflate';
import {isAdaptableHarnessCapability,runtimeBuildRequirements} from '../src/migration/domain/migration-harness.js';
import {canonicalSha256} from '../src/shared/json-canonicalization.js';
import {validateRuntimeBuildResult,withResultDigest} from '../src/shared/contracts/runtime-builder.js';
import {runtimeBuildRequirementsYaml} from '../src/migration/infrastructure/migration-harness-serializer.js';
import {buildMigrationPlan} from '../src/migration/domain/migration-model.js';
import {createEvaluationService} from '../src/service/server.js';
import {analysisFixture,inspectionFixture} from './analysis-fixture.js';
import {RUNTIME_CAPABILITIES_SCHEMA_VERSION,RUNTIME_EXECUTION_SCHEMA_VERSION,RUNTIME_INSTANCE_SCHEMA_VERSION,RUNTIME_OBSERVATION_SCHEMA_VERSION} from '../src/shared/contracts/runtime-protocol-versions.js';
import Fastify from 'fastify';
import {workspaceFilesDigest} from '../src/contracts.js';

function requirement(){
  const inspection=inspectionFixture([]);
  inspection.runtimeCapabilities=[{name:'read_document',owner:'RUNTIME_HARNESS',migrationAction:'REQUIRES_RUNTIME_BUILDER',blocking:true,
    reason:'源 Runtime 提供带权限边界的文档读取能力',usageContract:'path:string -> string；仅允许工作区路径并保留错误语义',targetCapability:null,
    contract:{inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},outputSchema:{type:'object'},errorSchema:{type:'object'},semantics:'只允许读取当前隔离工作区内的文件'},
    constraints:{permissions:['workspace.read'],sideEffects:'read',isolation:'per_runtime_instance'},
    testAvailability:'UNCHECKED',consumerTools:['review_document'],evidence:[{path:'tools/review.py',line:8,kind:'SOURCE',detail:'text = context.read_document(path)'}]}];
  return inspection;
}

it('exports deterministic Runtime Builder requirements without blocking candidate generation',()=>{
  const inspection=requirement(),requirements=runtimeBuildRequirements(inspection);
  expect(requirements).toMatchObject({schemaVersion:'finance.runtime-build-requirements.v1',
    target:{protocols:{capabilities:RUNTIME_CAPABILITIES_SCHEMA_VERSION,observation:RUNTIME_OBSERVATION_SCHEMA_VERSION}},
    requiredCapabilities:[{name:'read_document',required:true,consumerTools:['review_document']}]});
  expect(requirements?.requirementsDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(runtimeBuildRequirementsYaml(inspection)).toContain('requestId:');
  expect(runtimeBuildRequirementsYaml(inspection)).toContain('name: read_document');
  expect(buildMigrationPlan(inspection,[],inspection.assetId)).toMatchObject({generationAllowed:true,technicalValidationAllowed:false});
});

it('refuses to emit executable requirements when only the legacy free-text contract exists',()=>{
  const inspection=requirement();
  delete inspection.runtimeCapabilities?.[0]?.contract;
  expect(runtimeBuildRequirements(inspection)).toEqual({schemaVersion:'finance.runtime-build-requirements.v1',status:'INCOMPLETE_REQUIREMENTS',missing:[{name:'read_document',fields:['contract']}]});
});

it('accepts only a complete matching Builder result and verifies the deployed Launcher',()=>{
  const requirements=runtimeBuildRequirements(requirement(),{runtimeType:'openjiuwen',requestId:'migration-1:revision-1'});
  if(!requirements||'status' in requirements)throw new Error('expected complete requirements');
  const capabilities={schemaVersion:RUNTIME_CAPABILITIES_SCHEMA_VERSION,runtime:{type:'openjiuwen',version:'1.0.0'},models:[{modelId:'execution',upstreamModelId:'glm-4-plus'}],defaultModelId:'execution',
    observability:{schemaVersion:'finance.runtime-observation-capabilities.v1',profile:'core' as const,supportedKinds:['execution.started','execution.completed','execution.failed'],nativeEvents:false,replayable:false},
    features:{streaming:true,asyncLaunch:true,packagedMcp:true,externalMcp:false,inlineSecrets:true},limits:{maxArchiveBytes:1,maxFiles:1,maxTimeoutMs:1,maxConcurrentInstances:1}};
  const protocols={capabilities:RUNTIME_CAPABILITIES_SCHEMA_VERSION,instance:RUNTIME_INSTANCE_SCHEMA_VERSION,execution:RUNTIME_EXECUTION_SCHEMA_VERSION,observation:RUNTIME_OBSERVATION_SCHEMA_VERSION};
  const launcher={schemaVersion:'finance.runtime-launcher-descriptor.v1' as const,deploymentId:'deployment-1',baseUrl:'https://runtime.example.test/deployment-1/',runtime:capabilities.runtime,protocols,
    authentication:{type:'none' as const},artifactSha256:'e'.repeat(64),capabilitiesDigest:canonicalSha256(capabilities),expiresAt:null};
  const result=withResultDigest({schemaVersion:'finance.runtime-build-result.v1',buildId:'build-1',requestId:requirements.requestId,
    requirementsDigest:requirements.requirementsDigest,status:'SUCCEEDED',builder:{name:'fixture-builder',version:'1.0.0'},
    launcher,
    capabilityResults:requirements.requiredCapabilities.map(item=>({requirementId:item.id,status:'IMPLEMENTED' as const,capabilityId:'workspace.read_document',contractDigest:canonicalSha256(item.contract),verificationIds:['contract-read-document']})),
    verifications:[{id:'contract-read-document',type:'CONTRACT_TEST',status:'PASSED',evidenceSha256:'a'.repeat(64)}],errors:[],builtAt:'2026-09-29T12:00:00.000Z'});
  expect(validateRuntimeBuildResult(requirements,result,capabilities)).toEqual([]);
  expect(validateRuntimeBuildResult(requirements,{...result,requirementsDigest:'f'.repeat(64)},capabilities)).toContain('INVALID_RESULT_DIGEST');
  const {resultDigest:_digest,...resultBody}=result;
  const partial=withResultDigest({...resultBody,status:'PARTIAL',launcher:null});
  expect(validateRuntimeBuildResult(requirements,partial,capabilities)).toContain('BUILD_STATUS_PARTIAL');
  expect(validateRuntimeBuildResult(requirements,result,{...capabilities,runtime:{...capabilities.runtime,version:'changed'}})).toContain('LAUNCHER_RUNTIME_VERSION_MISMATCH');
});

it('does not mistake framework registration and response wrappers for a Runtime requirement',()=>{
  const inspection=inspectionFixture([]),capability={name:'AgentScope registration',owner:'RUNTIME_HARNESS' as const,
    migrationAction:'REQUIRES_RUNTIME_BUILDER' as const,blocking:true as const,reason:'Framework registration glue',
    usageContract:'Toolkit registers ToolBase and ToolResponse wraps results',targetCapability:null,testAvailability:'UNCHECKED' as const,
    consumerTools:['lookup'],evidence:[{path:'runtime.py',line:1,kind:'SOURCE',detail:'register_tool(ToolBase); return ToolResponse(...)'}]};
  inspection.runtimeCapabilities=[capability];
  expect(isAdaptableHarnessCapability(capability)).toBe(false);
  expect(runtimeBuildRequirements(inspection)).toBeNull();
});

it('keeps evidence and contracts in the YAML without requiring real runtime values',()=>{
  const yaml=runtimeBuildRequirementsYaml(requirement())!;
  expect(yaml).toContain('contract:');
  expect(yaml).toContain('tools/review.py');
  expect(yaml).not.toMatch(/api[_-]?key|bearer\s+[a-z0-9]/iu);
});

it('serves the YAML while keeping the migration plan generatable',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'runtime-builder-requirement-'));
  const launcherServer=Fastify();let instanceRunId='',migrationFile='',removeMigrationDuringProbe=false;let removedMigration:Buffer|null=null;
  const capabilities={schemaVersion:RUNTIME_CAPABILITIES_SCHEMA_VERSION,runtime:{type:'openjiuwen',version:'1.0.0'},models:[{modelId:'execution',upstreamModelId:'glm-4-plus'}],defaultModelId:'execution',
    observability:{schemaVersion:'finance.runtime-observation-capabilities.v1',profile:'core' as const,supportedKinds:['execution.started','execution.completed','execution.failed'] as const,nativeEvents:false,replayable:false},
    features:{streaming:true,asyncLaunch:true,packagedMcp:true,externalMcp:false,inlineSecrets:true},limits:{maxArchiveBytes:1,maxFiles:5,maxTimeoutMs:300000,maxConcurrentInstances:1}};
  launcherServer.get('/v1/runtime-capabilities',()=>capabilities);
  launcherServer.post('/v1/runtime-instances',request=>{instanceRunId=(request.body as {runId:string}).runId;return {schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:'probe',status:'ready',executeEndpoint:'/v1/runtime-instances/probe/execute',expiresAt:new Date(Date.now()+60_000).toISOString(),error:null,configurationDigest:'probe-config'};});
  launcherServer.get('/v1/runtime-instances/probe',()=>({schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:'probe',status:'ready',executeEndpoint:'/v1/runtime-instances/probe/execute',expiresAt:new Date(Date.now()+60_000).toISOString(),error:null,configurationDigest:'probe-config'}));
  launcherServer.post('/v1/runtime-instances/probe/execute',async request=>{const body=request.body as {caseId:string;workspaceFiles:Array<{path:string;content:string}>};
    if(removeMigrationDuringProbe){removedMigration=await readFile(migrationFile);await rm(migrationFile);removeMigrationDuringProbe=false;}
    return {runId:instanceRunId,caseId:body.caseId,side:'right',modelId:'execution',skillVersion:null,status:'completed',output:'CONFORMANCE_OK',elapsedMs:1,toolCalls:[],loadedSkills:[],usage:null,runtimeIdentityVerified:true,streamCompleted:true,error:null,metadata:{instanceConfigurationDigest:'probe-config',workspaceFilesDigest:workspaceFilesDigest(body.workspaceFiles)}};});
  launcherServer.delete('/v1/runtime-instances/probe',(_request,reply)=>reply.code(204).send());
  await launcherServer.listen({host:'127.0.0.1',port:0});const launcherAddress=launcherServer.server.address();if(!launcherAddress||typeof launcherAddress==='string')throw new Error('missing launcher address');
  const baseAnalyzer=analysisFixture([]),analyzer:typeof baseAnalyzer=async input=>{
    const result=await baseAnalyzer(input);
    result.payload.runtimeCapabilities=[{name:'read_document',reason:'源 Runtime 的独立文件能力',usageContract:'path:string -> string',
      contract:{inputSchema:{type:'object'},outputSchema:{type:'object'},errorSchema:{type:'object'},semantics:'只读当前隔离工作区'},
      constraints:{permissions:['workspace.read'],sideEffects:'read',isolation:'per_runtime_instance'},
      consumerTools:[],evidence:[{path:'SKILL.md',snippet:'Runtime provides read_document(path).'}]}];
    return result;
  };
  const baseUrl=`http://127.0.0.1:${launcherAddress.port}/`;
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:directory,accessToken:'test-token',publicDemo:false,migrationAnalyzer:analyzer,
    launcherTrust:[{reference:'builder-local',label:'Builder local',baseUrlPrefix:baseUrl,credentialEnv:null}]});
  const headers={authorization:'Bearer test-token'},archive=Buffer.from(zipSync({'SKILL.md':strToU8('---\nname: runtime-required\nversion: 1.0.0\ndescription: test\n---\nRuntime provides read_document(path).\n')}));
  try{
    const uploaded=await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:archive});
    const asset=uploaded.json(),created=await app.inject({method:'POST',url:'/api/migrations',headers,payload:{sourceAssetId:asset.assetId,name:'Runtime requirement'}}),id=created.json().id;
    migrationFile=path.join(directory,'migrations',`${id}.json`);
    expect((await app.inject({method:'POST',url:`/api/migrations/${id}/inspect`,headers})).statusCode).toBe(200);
    const yaml=await app.inject({method:'GET',url:`/api/migrations/${id}/runtime-requirements.yaml`,headers});
    expect(yaml.statusCode).toBe(200);expect(yaml.headers['content-type']).toContain('application/yaml');expect(yaml.body).toContain('requirementsDigest:');
    const plan=await app.inject({method:'GET',url:`/api/migrations/${id}/plan`,headers});
    expect(plan.statusCode).toBe(200);expect(plan.json()).toMatchObject({generationAllowed:false,technicalValidationAllowed:false});
    expect(plan.json().skillBlockingReasons).toContain('请生成并确认可复用迁移方案');
    const requirementsResponse=await app.inject({method:'GET',url:`/api/migrations/${id}/runtime-requirements`,headers});
    const requirements=requirementsResponse.json();
    const protocols={capabilities:RUNTIME_CAPABILITIES_SCHEMA_VERSION,instance:RUNTIME_INSTANCE_SCHEMA_VERSION,execution:RUNTIME_EXECUTION_SCHEMA_VERSION,observation:RUNTIME_OBSERVATION_SCHEMA_VERSION};
    const result=withResultDigest({schemaVersion:'finance.runtime-build-result.v1',buildId:'build-http',requestId:requirements.requestId,requirementsDigest:requirements.requirementsDigest,status:'SUCCEEDED',builder:{name:'fixture-builder',version:'1.0.0'},
      launcher:{schemaVersion:'finance.runtime-launcher-descriptor.v1',deploymentId:'deployment-http',baseUrl,runtime:capabilities.runtime,protocols,authentication:{type:'none'},artifactSha256:'e'.repeat(64),capabilitiesDigest:canonicalSha256(capabilities),expiresAt:null},
      capabilityResults:requirements.requiredCapabilities.map((item:{id:string;contract:unknown})=>({requirementId:item.id,status:'IMPLEMENTED' as const,capabilityId:'workspace.read_document',contractDigest:canonicalSha256(item.contract),verificationIds:['verify-http']})),
      verifications:[{id:'verify-http',type:'CONTRACT_TEST',status:'PASSED',evidenceSha256:'a'.repeat(64)}],errors:[],builtAt:new Date().toISOString()});
    removeMigrationDuringProbe=true;
    const failed=await app.inject({method:'POST',url:`/api/migrations/${id}/runtime-deliveries`,headers,payload:{result,trustReference:'builder-local'}});
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);expect(await readdir(path.join(directory,'environments'))).toEqual([]);
    if(!removedMigration)throw new Error('migration failure fixture did not remove the project');await writeFile(migrationFile,removedMigration);
    const accepted=await app.inject({method:'POST',url:`/api/migrations/${id}/runtime-deliveries`,headers,payload:{result,trustReference:'builder-local'}});
    expect(accepted.statusCode,accepted.body).toBe(200);expect(accepted.json()).toMatchObject({status:'ACCEPTED',environment:{delivery:{evalConformance:{status:'PASSED'}}}});
    const project=await app.inject({method:'GET',url:`/api/migrations/${id}`,headers});
    expect(project.json()).toMatchObject({runtimeDelivery:{environmentId:accepted.json().environment.environmentId,deploymentId:'deployment-http',requirementsDigest:requirements.requirementsDigest,evalConformance:{status:'PASSED'}}});
    const report=await app.inject({method:'GET',url:`/api/migrations/${id}/report`,headers});
    expect(report.statusCode,report.body).toBe(200);
    expect(report.json().runtimeRequirements).toBeNull();
    const repeated=await app.inject({method:'POST',url:`/api/migrations/${id}/runtime-deliveries`,headers,payload:{result,trustReference:'builder-local'}});
    expect(repeated.statusCode,repeated.body).toBe(200);expect(repeated.json().environment.environmentId).toBe(accepted.json().environment.environmentId);
  }finally{await app.close();await launcherServer.close();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
