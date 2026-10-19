import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '../src/shared/json-canonicalization.js';
import { runtimeBuildRequirementsSchema, runtimeBuildResultSchema, validateRuntimeBuildResult, withRequirementsDigest, withResultDigest } from '../src/shared/contracts/runtime-builder.js';
import { RUNTIME_CAPABILITIES_SCHEMA_VERSION, RUNTIME_EXECUTION_SCHEMA_VERSION, LEGACY_RUNTIME_INSTANCE_SCHEMA_VERSION, RUNTIME_OBSERVATION_SCHEMA_VERSION } from '../src/shared/contracts/runtime-protocol-versions.js';

function fixtures() {
  const capabilities = {
    schemaVersion: RUNTIME_CAPABILITIES_SCHEMA_VERSION, runtime: { type: 'openjiuwen', version: '1.0.0' },
    models: [{ modelId: 'execution', upstreamModelId: 'glm-4-plus' }], defaultModelId: 'execution',
    observability: { schemaVersion: 'finance.runtime-observation-capabilities.v1', profile: 'core' as const, supportedKinds: ['execution.started', 'execution.completed', 'execution.failed'] as const, nativeEvents: false, replayable: false },
    features: { streaming: true, asyncLaunch: true, packagedMcp: true, externalMcp: false, inlineSecrets: true },
    limits: { maxArchiveBytes: 1, maxFiles: 1, maxTimeoutMs: 1, maxConcurrentInstances: 1 },
  };
  const protocols = { capabilities: RUNTIME_CAPABILITIES_SCHEMA_VERSION, instance: LEGACY_RUNTIME_INSTANCE_SCHEMA_VERSION, execution: RUNTIME_EXECUTION_SCHEMA_VERSION, observation: RUNTIME_OBSERVATION_SCHEMA_VERSION };
  const requirements = withRequirementsDigest({ schemaVersion: 'finance.runtime-build-requirements.v1', requestId: 'migration-1:revision-1', source: { assetId: 'asset-1', artifactSha256: 'a'.repeat(64) }, target: { runtimeType: 'openjiuwen', protocols }, requiredCapabilities: [{ id: 'harness-1-read-document', name: 'read_document', required: true, reason: 'read workspace document', contract: { inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, errorSchema: { type: 'object' }, semantics: 'workspace only' }, constraints: { permissions: ['workspace.read'], sideEffects: 'read', isolation: 'per_runtime_instance' }, preferredTargetCapability: null, consumerTools: ['review_document'], evidence: [{ path: 'tools/review.py', line: 8, detail: 'read_document(path)' }] }] });
  const launcher = { schemaVersion: 'finance.runtime-launcher-descriptor.v1' as const, deploymentId: 'deployment-1', baseUrl: 'https://runtime.example.test/deployment-1/', runtime: capabilities.runtime, protocols, authentication: { type: 'bearer' as const, audience: 'finance-skill-eval' }, artifactSha256: 'e'.repeat(64), capabilitiesDigest: canonicalSha256(capabilities), expiresAt: null };
  const base = { schemaVersion: 'finance.runtime-build-result.v1' as const, buildId: 'build-1', requestId: requirements.requestId, requirementsDigest: requirements.requirementsDigest, status: 'SUCCEEDED' as const, builder: { name: 'builder', version: '1.0.0' }, launcher, capabilityResults: [{ requirementId: 'harness-1-read-document', status: 'IMPLEMENTED' as const, capabilityId: 'workspace.read_document', contractDigest: canonicalSha256(requirements.requiredCapabilities[0]!.contract), verificationIds: ['contract-1'] }], verifications: [{ id: 'contract-1', type: 'CONTRACT_TEST', status: 'PASSED' as const, evidenceSha256: 'b'.repeat(64) }], errors: [], builtAt: '2026-09-29T12:00:00.000Z' };
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
    baseline:{deploymentId:'deployment-1',artifactSha256:'e'.repeat(64),solutionRevisionId:'f'.repeat(64)},
    hypothesis:{id:'finding-1',issue:'The prior Launcher loses the required state boundary.',expectedBehavior:'Preserve isolated state across two tool calls in one case.'},
    evidence:[{jobId:'job-1',caseId:'case-1',summary:'Tool trace showed a missing state handoff.'}],
  }});
  const {resultDigest:_resultDigest,...resultBody}=result;
  const unchanged=withResultDigest({...resultBody,requestId:rebuild.requestId,requirementsDigest:rebuild.requirementsDigest});
  expect(validateRuntimeBuildResult(rebuild,unchanged,capabilities)).toEqual(expect.arrayContaining(['REBUILD_DEPLOYMENT_UNCHANGED','REBUILD_ARTIFACT_UNCHANGED']));
  const revised=withResultDigest({...resultBody,requestId:rebuild.requestId,requirementsDigest:rebuild.requirementsDigest,
    launcher:{...result.launcher!,deploymentId:'deployment-2',artifactSha256:'0'.repeat(64)}});
  expect(validateRuntimeBuildResult(rebuild,revised,capabilities)).toEqual([]);
});

it('validates new v2 task examples and preserves the legacy v1 examples',async()=>{
  const {taskBuildProfileSchema,taskBuildReceiptSchema}=await import('../src/shared/contracts/task-builder.js');
  const load=async(name:string)=>JSON.parse(await readFile(new URL(`../contracts/runtime-builder/examples/${name}`,import.meta.url),'utf8'));
  const requirements=await load('task.v2.requirements.success.json'),result=await load('task.v2.result.success.json'),capabilities=await load('task.capabilities.json');
  expect(validateRuntimeBuildResult(await load('task.requirements.success.json'),await load('task.result.success.json'),capabilities)).toEqual([]);
  expect(validateRuntimeBuildResult(requirements,result,capabilities)).toEqual([]);
  const profile=taskBuildProfileSchema.parse(requirements.extensions.migrationTask),receipt=taskBuildReceiptSchema.parse(result.extensions.migrationTask);
  expect(receipt.candidateDigest).toBe(profile.candidateDigest);expect(receipt.taskId).toBe(profile.taskId);
  expect(profile.skills).toHaveLength(1);expect(capabilities.features.multiSkill).toBe(true);
  expect(()=>taskBuildReceiptSchema.parse({...receipt,instanceSchemaVersion:'finance.skill-eval.runtime-instance.v1'})).toThrow();
});
