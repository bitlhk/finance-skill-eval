import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
import {canonicalJson,canonicalSha256} from '../src/shared/json-canonicalization.js';
import {runtimeBuildRequirementsSchema,runtimeBuildResultSchema,validateRuntimeBuildResult,withRequirementsDigest,withResultDigest} from '../src/shared/contracts/runtime-builder.js';

function fixtures(){
  const artifact=Buffer.from('runtime-builder-fixture');
  const requirements=withRequirementsDigest({schemaVersion:'finance.runtime-build-requirements.v1',requestId:'migration-1:revision-1',source:{assetId:'asset-1',artifactSha256:'a'.repeat(64)},
    target:{runtimeType:'openjiuwen',protocols:{registration:'registration.v2',instance:'instance.v1',execution:'execution.v1'}},
    requiredCapabilities:[{id:'harness-1-read-document',name:'read_document',required:true,reason:'read workspace document',contract:{inputSchema:{type:'object'},outputSchema:{type:'object'},errorSchema:{type:'object'},semantics:'workspace only'},constraints:{permissions:['workspace.read'],sideEffects:'read',isolation:'per_runtime_instance'},preferredTargetCapability:null,consumerTools:['review_document'],evidence:[{path:'tools/review.py',line:8,detail:'read_document(path)'}]}]});
  const base={schemaVersion:'finance.runtime-build-result.v1' as const,buildId:'build-1',requestId:requirements.requestId,requirementsDigest:requirements.requirementsDigest,status:'SUCCEEDED' as const,builder:{name:'builder',version:'1.0.0'},artifact:{mediaType:'application/vnd.finance.agent-runtime+zip',uri:'artifact://build-1',sha256:createHash('sha256').update(artifact).digest('hex')},runtime:{runtimeType:'openjiuwen',version:'1.0.0',protocols:requirements.target.protocols,requiredConfiguration:[]},capabilityResults:[{requirementId:'harness-1-read-document',status:'IMPLEMENTED' as const,capabilityId:'workspace.read_document',contractDigest:canonicalSha256(requirements.requiredCapabilities[0]!.contract),verificationIds:['contract-1']}],verifications:[{id:'contract-1',type:'CONTRACT_TEST',status:'PASSED' as const,evidenceSha256:'b'.repeat(64)}],errors:[],builtAt:'2026-09-29T12:00:00.000Z'};
  return {artifact,requirements,result:withResultDigest(base),base};
}

it('implements RFC 8785 key ordering and rejects non-JSON values',()=>{
  expect(canonicalJson({z:1,a:'x',nested:{b:true,a:null}})).toBe('{"a":"x","nested":{"a":null,"b":true},"z":1}');
  expect(()=>canonicalJson({bad:undefined})).toThrow('undefined');
  expect(()=>canonicalJson(Number.NaN)).toThrow('finite');
});

it('round-trips strict requirements and result contracts',()=>{
  const {requirements,result}=fixtures();
  expect(runtimeBuildRequirementsSchema.parse(JSON.parse(JSON.stringify(requirements)))).toEqual(requirements);
  expect(runtimeBuildResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  expect(()=>runtimeBuildRequirementsSchema.parse({...requirements,unknown:true})).toThrow();
});

it('ships parseable success, partial, failed and incomplete examples',async()=>{
  const root=new URL('../contracts/runtime-builder/examples/',import.meta.url);
  const requirements=JSON.parse(await readFile(new URL('requirements.success.json',root),'utf8'));
  expect(runtimeBuildRequirementsSchema.parse(requirements).requirementsDigest).toMatch(/^[a-f0-9]{64}$/u);
  for(const name of ['result.success.json','result.partial.json','result.failed.json'])expect(runtimeBuildResultSchema.parse(JSON.parse(await readFile(new URL(name,root),'utf8'))).status).toBeTruthy();
  const incomplete=JSON.parse(await readFile(new URL('requirements.incomplete.json',root),'utf8'));
  expect(incomplete).toMatchObject({status:'INCOMPLETE_REQUIREMENTS',missing:[{fields:['contract','constraints']}]});
});

it('rejects digest, duplicate, missing, contract, protocol and artifact mismatches',()=>{
  const {artifact,requirements,result,base}=fixtures();
  expect(validateRuntimeBuildResult(requirements,result,artifact)).toEqual([]);
  expect(validateRuntimeBuildResult(requirements,{...result,requirementsDigest:'c'.repeat(64)},artifact)).toContain('REQUIREMENTS_DIGEST_MISMATCH');
  const duplicate=withResultDigest({...base,capabilityResults:[...base.capabilityResults,...base.capabilityResults]});
  expect(validateRuntimeBuildResult(requirements,duplicate,artifact)).toContain('DUPLICATE_REQUIREMENT_harness-1-read-document');
  const missing=withResultDigest({...base,capabilityResults:[]});
  expect(validateRuntimeBuildResult(requirements,missing,artifact)).toContain('REQUIREMENT_RESULT_COUNT_harness-1-read-document');
  const incompatible=withResultDigest({...base,capabilityResults:base.capabilityResults.map(item=>({...item,contractDigest:'d'.repeat(64)}))});
  expect(validateRuntimeBuildResult(requirements,incompatible,artifact)).toContain('CONTRACT_INCOMPATIBLE_harness-1-read-document');
  const protocols=withResultDigest({...base,runtime:{...base.runtime,protocols:{...base.runtime.protocols,execution:'execution.v0'}}});
  expect(validateRuntimeBuildResult(requirements,protocols,artifact)).toContain('PROTOCOL_MISMATCH_EXECUTION');
  expect(validateRuntimeBuildResult(requirements,result,Buffer.from('wrong'))).toContain('ARTIFACT_DIGEST_MISMATCH');
});
