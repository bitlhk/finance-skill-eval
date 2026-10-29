import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/shared/json-canonicalization.js';
import { runtimeBuildRequirementsSchema, runtimeBuildResultSchema, validateRuntimeBuildResult, withRequirementsDigest, withResultDigest } from '../src/shared/contracts/runtime-builder.js';
import { RUNTIME_CAPABILITIES_SCHEMA_VERSION, RUNTIME_EXECUTION_SCHEMA_VERSION, RUNTIME_INSTANCE_SCHEMA_VERSION, RUNTIME_OBSERVATION_SCHEMA_VERSION } from '../src/shared/contracts/runtime-protocol-versions.js';

function fixtures() {
  const capabilities = {
    schemaVersion: RUNTIME_CAPABILITIES_SCHEMA_VERSION, instanceSchemaVersion:RUNTIME_INSTANCE_SCHEMA_VERSION,platform:{os:'linux',arch:'x64',isolation:'trusted_local_process'},nativeToolNames:['read_document'],nativeCapabilities:[] as any[], runtime: { type: 'openjiuwen', version: '1.0.0' },
    models: [{ modelId: 'execution', upstreamModelId: 'glm-4-plus' }], defaultModelId: 'execution',
    observability: { schemaVersion: 'finance.runtime-observation-capabilities.v1', profile: 'core' as const, supportedKinds: ['execution.started', 'execution.completed', 'execution.failed'] as const, nativeEvents: false, replayable: false },
    features: { streaming: true, asyncLaunch: true, packagedMcp: true, externalMcp: false, inlineSecrets: true },
    limits: { maxSkills:1, maxArchiveBytes: 1, maxFiles: 1, maxTimeoutMs: 1, maxConcurrentInstances: 1 },
  };
  const protocols = { capabilities: RUNTIME_CAPABILITIES_SCHEMA_VERSION, instance: RUNTIME_INSTANCE_SCHEMA_VERSION, execution: RUNTIME_EXECUTION_SCHEMA_VERSION, observation: RUNTIME_OBSERVATION_SCHEMA_VERSION };
  const requirements = withRequirementsDigest({ schemaVersion: 'finance.runtime-build-requirements.v3', requestId: 'migration-1:revision-1', executionRequirements:{platform:{os:'linux',arch:'x64',isolation:'trusted_local_process'},features:['streaming'],limits:{maxSkills:1,maxFiles:1,maxArchiveBytes:1,maxTimeoutMs:1}}, target: { runtimeType: 'openjiuwen', protocols }, requiredCapabilities: [{ id: 'harness-1-read-document', name: 'read_document', required: true, reason: 'read workspace document', contract: { inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, errorSchema: { type: 'object' }, semantics: 'workspace only' }, constraints: { permissions: ['workspace.read'], sideEffects: 'read', isolation: 'per_runtime_instance' }, preferredTargetCapability: null, consumerTools: ['review_document'], evidence: [{ path: 'tools/review.py', line: 8, detail: 'read_document(path)' }] }] });
  capabilities.nativeCapabilities=[{capabilityId:'workspace.read_document',name:'read_document',contract:requirements.requiredCapabilities[0]!.contract,constraints:requirements.requiredCapabilities[0]!.constraints}];
  const launcher = { schemaVersion: 'finance.runtime-launcher-descriptor.v2' as const, deploymentId: 'deployment-1', baseUrl: 'https://runtime.example.test/deployment-1/', runtime: capabilities.runtime, protocols, authentication: { type: 'bearer' as const, audience: 'finance-skill-eval' }, artifactSha256: 'e'.repeat(64), capabilitiesDigest: canonicalSha256(capabilities), expiresAt: null };
  const base = { schemaVersion: 'finance.runtime-build-result.v3' as const, buildId: 'build-1', requestId: requirements.requestId, requirementsDigest: requirements.requirementsDigest, status: 'SUCCEEDED' as const, builder: { name: 'builder', version: '1.0.0' }, launcher, capabilityResults: [{ requirementId: 'harness-1-read-document', status: 'IMPLEMENTED' as const, capabilityId: 'workspace.read_document', contractDigest: canonicalSha256(requirements.requiredCapabilities[0]!.contract), verificationIds: ['contract-1'] }], verifications: [{id:'lifecycle',type:'RUNTIME_LIFECYCLE',status:'PASSED' as const,evidenceSha256:'f'.repeat(64)},{ id: 'contract-1', type: 'CONTRACT_TEST', status: 'PASSED' as const, evidenceSha256: 'b'.repeat(64) }], errors: [], builtAt: '2026-09-29T12:00:00.000Z' };
  return { capabilities, requirements, result: withResultDigest(base), base };
}

it('implements RFC 8785 key ordering and rejects non-JSON values', () => {
  expect(canonicalJson({ z: 1, a: 'x', nested: { b: true, a: null } })).toBe('{"a":"x","nested":{"a":null,"b":true},"z":1}');
  expect(() => canonicalJson({ bad: undefined })).toThrow('undefined');
  expect(() => canonicalJson(Number.NaN)).toThrow('finite');
});

it('round-trips strict requirements and deployed Launcher result contracts', () => {
  const { requirements, result } = fixtures();
  expect(runtimeBuildRequirementsSchema.parse(JSON.parse(JSON.stringify(requirements)))).toEqual(requirements);
  expect(runtimeBuildResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  expect(() => runtimeBuildRequirementsSchema.parse({ ...requirements, unknown: true })).toThrow();
  expect(() => withResultDigest({ ...fixtures().base, status: 'FAILED', launcher: fixtures().base.launcher })).toThrow(/must not return an active Launcher/u);
});

it('ships parseable success, partial, failed and incomplete examples', async () => {
  const root = new URL('../contracts/runtime-builder/examples/', import.meta.url);
  const requirements = JSON.parse(await readFile(new URL('requirements.success.json', root), 'utf8'));
  expect(runtimeBuildRequirementsSchema.parse(requirements).requirementsDigest).toMatch(/^[a-f0-9]{64}$/u);
  for (const name of ['result.success.json', 'result.partial.json', 'result.failed.json']) expect(runtimeBuildResultSchema.parse(JSON.parse(await readFile(new URL(name, root), 'utf8'))).status).toBeTruthy();
  const success = JSON.parse(await readFile(new URL('result.success.json', root), 'utf8'));
  const capabilities = JSON.parse(await readFile(new URL('../contracts/runtime-launcher/examples/builder-capabilities.json', import.meta.url), 'utf8'));
  expect(validateRuntimeBuildResult(requirements, success, capabilities)).toEqual([]);
  const incomplete = JSON.parse(await readFile(new URL('requirements.incomplete.json', root), 'utf8'));
  expect(incomplete).toMatchObject({ status: 'INCOMPLETE_REQUIREMENTS', missing: [{ fields: ['contract', 'constraints'] }] });
});

it('rejects digest, duplicate, missing, contract and Launcher capability mismatches', () => {
  const { capabilities, requirements, result, base } = fixtures();
  expect(validateRuntimeBuildResult(requirements, result, capabilities)).toEqual([]);
  expect(validateRuntimeBuildResult(requirements, { ...result, requirementsDigest: 'c'.repeat(64) }, capabilities)).toContain('REQUIREMENTS_DIGEST_MISMATCH');
  const duplicate = withResultDigest({ ...base, capabilityResults: [...base.capabilityResults, ...base.capabilityResults] });
  expect(validateRuntimeBuildResult(requirements, duplicate, capabilities)).toContain('DUPLICATE_REQUIREMENT_harness-1-read-document');
  const missing = withResultDigest({ ...base, capabilityResults: [] });
  expect(validateRuntimeBuildResult(requirements, missing, capabilities)).toContain('REQUIREMENT_RESULT_COUNT_harness-1-read-document');
  const incompatible = withResultDigest({ ...base, capabilityResults: base.capabilityResults.map(item => ({ ...item, contractDigest: 'd'.repeat(64) })) });
  expect(validateRuntimeBuildResult(requirements, incompatible, capabilities)).toContain('CONTRACT_INCOMPATIBLE_harness-1-read-document');
  expect(validateRuntimeBuildResult(requirements, result)).toContain('CAPABILITIES_NOT_PROVIDED');
  const drifted = withResultDigest({ ...base, launcher: { ...base.launcher, capabilitiesDigest: '0'.repeat(64) } });
  expect(validateRuntimeBuildResult(requirements, drifted, capabilities)).toContain('LAUNCHER_CAPABILITIES_DIGEST_MISMATCH');
});

it('binds an iterative rebuild to its previous solution and rejects the old deployment',()=>{
  const {requirements,result,capabilities}=fixtures();
  const {requirementsDigest:_digest,...body}=requirements;
  const rebuild=withRequirementsDigest({...body,requestId:'migration-1:rebuild-1',rebuild:{
    baseline:{deploymentId:'deployment-1',artifactSha256:'e'.repeat(64),capabilitiesDigest:'f'.repeat(64)},
    hypothesis:{id:'finding-1',issue:'The prior Launcher loses the required state boundary.',expectedBehavior:'Preserve isolated state across two tool calls in one case.'},
    evidence:[{evidenceRef:'job-1',probeRef:'case-1',summary:'Tool trace showed a missing state handoff.'}],
  }});
  const {resultDigest:_resultDigest,...resultBody}=result;
  const unchanged=withResultDigest({...resultBody,requestId:rebuild.requestId,requirementsDigest:rebuild.requirementsDigest});
  expect(validateRuntimeBuildResult(rebuild,unchanged,capabilities)).toEqual(expect.arrayContaining(['REBUILD_DEPLOYMENT_UNCHANGED','REBUILD_ARTIFACT_UNCHANGED']));
  const revised=withResultDigest({...resultBody,requestId:rebuild.requestId,requirementsDigest:rebuild.requirementsDigest,
    launcher:{...result.launcher!,deploymentId:'deployment-2',artifactSha256:'0'.repeat(64)}});
  expect(validateRuntimeBuildResult(rebuild,revised,capabilities)).toEqual([]);
});

it.each(['finance.runtime-build-requirements.v1','finance.runtime-build-requirements.v2'])('rejects removed build protocol %s',schemaVersion=>{
  const {requirements}=fixtures();
  expect(runtimeBuildRequirementsSchema.safeParse({...requirements,schemaVersion}).success).toBe(false);
});
it.each(['source','extensions'])('rejects consumer binding field %s',field=>{
  const {requirements}=fixtures();expect(runtimeBuildRequirementsSchema.safeParse({...requirements,[field]:{taskId:'consumer'}}).success).toBe(false);
});
it.each(['platform','permissions','capacity','feature'])('refuses incompatible reuse: %s',kind=>{
  const {requirements,result,capabilities}=fixtures();
  if(kind==='platform')capabilities.platform.os='windows';
  if(kind==='permissions')capabilities.nativeCapabilities[0].constraints={...capabilities.nativeCapabilities[0].constraints,permissions:['workspace.read','workspace.write']};
  if(kind==='capacity')capabilities.limits.maxFiles=0;
  if(kind==='feature')capabilities.features.streaming=false;
  if(kind==='capacity')expect(()=>validateRuntimeBuildResult(requirements,result,capabilities)).toThrow();
  else expect(validateRuntimeBuildResult(requirements,result,capabilities).length).toBeGreaterThan(0);
});
