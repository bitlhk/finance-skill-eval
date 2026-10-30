import { taskHttpFixture, standardFiles, encode } from './task-http-fixture.js';
import { standardExecutionRequirements } from './runtime-standard-fixture.js';
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
  const inspection=requirement(),requirements=runtimeBuildRequirements(inspection,{runtimeType:'openjiuwen',executionRequirements:standardExecutionRequirements});
  expect(requirements).toMatchObject({schemaVersion:'finance.runtime-build-requirements.v3',
    target:{protocols:{capabilities:RUNTIME_CAPABILITIES_SCHEMA_VERSION,observation:RUNTIME_OBSERVATION_SCHEMA_VERSION}},
    requiredCapabilities:[{name:'read_document',required:true,consumerTools:['review_document']}]});
  expect(requirements?.requirementsDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(runtimeBuildRequirementsYaml(inspection,'openjiuwen',standardExecutionRequirements)).toContain('requestId:');
  expect(runtimeBuildRequirementsYaml(inspection,'openjiuwen',standardExecutionRequirements)).toContain('name: read_document');
  expect(buildMigrationPlan(inspection,[],inspection.assetId)).toMatchObject({generationAllowed:true,technicalValidationAllowed:false});
});

it('refuses to emit executable requirements when only the legacy free-text contract exists',()=>{
  const inspection=requirement();
  delete inspection.runtimeCapabilities?.[0]?.contract;
  expect(runtimeBuildRequirements(inspection,{runtimeType:'openjiuwen',executionRequirements:standardExecutionRequirements})).toEqual({schemaVersion:'finance.runtime-build-requirements.v3',status:'INCOMPLETE_REQUIREMENTS',missing:[{name:'read_document',fields:['contract']}]});
});

it('accepts only a complete matching Builder result and verifies the deployed Launcher',()=>{
  const requirements=runtimeBuildRequirements(requirement(),{runtimeType:'openjiuwen',requestId:'migration-1:revision-1',executionRequirements:standardExecutionRequirements});
  if(!requirements||'status' in requirements)throw new Error('expected complete requirements');
  const capabilities={schemaVersion:RUNTIME_CAPABILITIES_SCHEMA_VERSION,instanceSchemaVersion:RUNTIME_INSTANCE_SCHEMA_VERSION,platform:standardExecutionRequirements.platform,nativeToolNames:['read_document'],nativeCapabilities:[{capabilityId:'workspace.read_document',name:'read_document',contract:requirements.requiredCapabilities[0]!.contract,constraints:requirements.requiredCapabilities[0]!.constraints}],runtime:{type:'openjiuwen',version:'1.0.0'},models:[{modelId:'execution',upstreamModelId:'glm-4-plus'}],defaultModelId:'execution',
    observability:{schemaVersion:'finance.runtime-observation-capabilities.v1',profile:'core' as const,supportedKinds:['execution.started','execution.completed','execution.failed'],nativeEvents:false,replayable:false},
    features:{streaming:true,asyncLaunch:true,packagedMcp:true,externalMcp:false,inlineSecrets:true},limits:{maxSkills:1,maxArchiveBytes:1,maxFiles:1,maxTimeoutMs:1,maxConcurrentInstances:1}};
  const protocols={capabilities:RUNTIME_CAPABILITIES_SCHEMA_VERSION,instance:RUNTIME_INSTANCE_SCHEMA_VERSION,execution:RUNTIME_EXECUTION_SCHEMA_VERSION,observation:RUNTIME_OBSERVATION_SCHEMA_VERSION};
  const launcher={schemaVersion:'finance.runtime-launcher-descriptor.v2' as const,deploymentId:'deployment-1',baseUrl:'https://runtime.example.test/deployment-1/',runtime:capabilities.runtime,protocols,
    authentication:{type:'none' as const},artifactSha256:'e'.repeat(64),capabilitiesDigest:canonicalSha256(capabilities),expiresAt:null};
  const result=withResultDigest({schemaVersion:'finance.runtime-build-result.v3',buildId:'build-1',requestId:requirements.requestId,
    requirementsDigest:requirements.requirementsDigest,status:'SUCCEEDED',builder:{name:'fixture-builder',version:'1.0.0'},
    launcher,
    capabilityResults:requirements.requiredCapabilities.map(item=>({requirementId:item.id,status:'IMPLEMENTED' as const,capabilityId:'workspace.read_document',contractDigest:canonicalSha256(item.contract),verificationIds:['contract-read-document']})),
    verifications:[{id:'lifecycle',type:'RUNTIME_LIFECYCLE',status:'PASSED',evidenceSha256:'d'.repeat(64)},{id:'contract-read-document',type:'CONTRACT_TEST',status:'PASSED',evidenceSha256:'a'.repeat(64)}],errors:[],builtAt:'2026-09-29T12:00:00.000Z'});
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
  expect(runtimeBuildRequirements(inspection,{runtimeType:'openjiuwen',executionRequirements:standardExecutionRequirements})).toBeNull();
});

it('keeps evidence and contracts in the YAML without requiring real runtime values',()=>{
  const yaml=runtimeBuildRequirementsYaml(requirement(),'openjiuwen',standardExecutionRequirements)!;
  expect(yaml).toContain('contract:');
  expect(yaml).toContain('tools/review.py');
  expect(yaml).not.toMatch(/api[_-]?key|bearer\s+[a-z0-9]/iu);
});

it("serves generic requirements without source, credentials or business cases",async()=>{

 const f=await taskHttpFixture({count:3});await f.ready();const response=await f.buildRequest();expect(response.statusCode,response.body).toBe(200);
 const yaml=await f.api('GET',f.url()+'/runtime-requirements.yaml');expect(yaml.statusCode).toBe(200);expect(yaml.headers['content-type']).toContain('application/yaml');
 expect(yaml.body).toContain('finance.runtime-build-requirements.v3');expect(yaml.body).toContain('maxSkills: 3');expect(yaml.body).not.toMatch(/HOLDOUT_SECRET|source:|extensions:|candidateId:/);
 const req=response.json().runtimeBuildRequests.at(-1).requirements;
 expect((await f.api('GET',f.url()+'/runtime-build-requests/'+req.requestId+'/source.zip')).statusCode).toBe(404);

});
