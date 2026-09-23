import {expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {strToU8,zipSync} from 'fflate';
import {isAdaptableHarnessCapability,runtimeBuildRequirements,runtimeBuildRequirementsYaml} from '../src/service/migration-harness.js';
import {buildMigrationPlan} from '../src/migration/domain/migration-model.js';
import {createEvaluationService} from '../src/service/server.js';
import {analysisFixture,inspectionFixture} from './analysis-fixture.js';

function requirement(){
  const inspection=inspectionFixture([]);
  inspection.runtimeCapabilities=[{name:'read_document',owner:'RUNTIME_HARNESS',migrationAction:'REQUIRES_RUNTIME_BUILDER',blocking:true,
    reason:'源 Runtime 提供带权限边界的文档读取能力',usageContract:'path:string -> string；仅允许工作区路径并保留错误语义',targetCapability:null,
    testAvailability:'UNCHECKED',consumerTools:['review_document'],evidence:[{path:'tools/review.py',line:8,kind:'SOURCE',detail:'text = context.read_document(path)'}]}];
  return inspection;
}

it('exports deterministic Runtime Builder requirements without blocking candidate generation',()=>{
  const inspection=requirement(),requirements=runtimeBuildRequirements(inspection);
  expect(requirements).toMatchObject({schemaVersion:'finance.runtime-build-requirements.v1',status:'RUNTIME_BUILDER_REQUIRED',
    requiredCapabilities:[{name:'read_document',required:true,consumerTools:['review_document']}]});
  expect(requirements?.requirementsDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(runtimeBuildRequirementsYaml(inspection)).toContain('status: RUNTIME_BUILDER_REQUIRED');
  expect(runtimeBuildRequirementsYaml(inspection)).toContain('name: read_document');
  expect(buildMigrationPlan(inspection,[],inspection.assetId)).toMatchObject({generationAllowed:true,technicalValidationAllowed:false});
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
  expect(yaml).toContain('usageContract:');
  expect(yaml).toContain('tools/review.py');
  expect(yaml).not.toMatch(/api[_-]?key|bearer\s+[a-z0-9]/iu);
});

it('serves the YAML while keeping the migration plan generatable',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'runtime-builder-requirement-'));
  const baseAnalyzer=analysisFixture([]),analyzer:typeof baseAnalyzer=async input=>{
    const result=await baseAnalyzer(input);
    result.payload.runtimeCapabilities=[{name:'read_document',reason:'源 Runtime 的独立文件能力',usageContract:'path:string -> string',
      consumerTools:[],evidence:[{path:'SKILL.md',snippet:'Runtime provides read_document(path).'}]}];
    return result;
  };
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:directory,accessToken:'test-token',publicDemo:false,migrationAnalyzer:analyzer});
  const headers={authorization:'Bearer test-token'},archive=Buffer.from(zipSync({'SKILL.md':strToU8('---\nname: runtime-required\nversion: 1.0.0\ndescription: test\n---\nRuntime provides read_document(path).\n')}));
  try{
    const uploaded=await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:archive});
    const asset=uploaded.json(),created=await app.inject({method:'POST',url:'/api/migrations',headers,payload:{sourceAssetId:asset.assetId,name:'Runtime requirement'}}),id=created.json().id;
    expect((await app.inject({method:'POST',url:`/api/migrations/${id}/inspect`,headers})).statusCode).toBe(200);
    const yaml=await app.inject({method:'GET',url:`/api/migrations/${id}/runtime-requirements.yaml`,headers});
    expect(yaml.statusCode).toBe(200);expect(yaml.headers['content-type']).toContain('application/yaml');expect(yaml.body).toContain('RUNTIME_BUILDER_REQUIRED');
    const plan=await app.inject({method:'GET',url:`/api/migrations/${id}/plan`,headers});
    expect(plan.statusCode).toBe(200);expect(plan.json()).toMatchObject({generationAllowed:true,technicalValidationAllowed:false});
  }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});
