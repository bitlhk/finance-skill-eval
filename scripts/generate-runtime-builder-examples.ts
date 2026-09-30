import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalSha256 } from '../src/shared/json-canonicalization.js';
import { withRequirementsDigest, withResultDigest } from '../src/shared/contracts/runtime-builder.js';
import {
  RUNTIME_CAPABILITIES_SCHEMA_VERSION,
  RUNTIME_EXECUTION_SCHEMA_VERSION,
  RUNTIME_INSTANCE_SCHEMA_VERSION,
  RUNTIME_OBSERVATION_SCHEMA_VERSION,
} from '../src/shared/contracts/runtime-protocol-versions.js';

const directory = path.resolve('contracts/runtime-builder/examples');
await mkdir(directory, { recursive: true });
const requirements = withRequirementsDigest({
  schemaVersion: 'finance.runtime-build-requirements.v1', requestId: 'migration-example:revision-1',
  source: { assetId: 'asset-example', artifactSha256: 'a'.repeat(64) },
  target: { runtimeType: 'openjiuwen', protocols: { capabilities: RUNTIME_CAPABILITIES_SCHEMA_VERSION, instance: RUNTIME_INSTANCE_SCHEMA_VERSION, execution: RUNTIME_EXECUTION_SCHEMA_VERSION, observation: RUNTIME_OBSERVATION_SCHEMA_VERSION } },
  requiredCapabilities: [{ id: 'harness-1-read-document', name: 'read_document', required: true, reason: 'Skill 依赖 Runtime 读取工作区内文档', contract: { inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, outputSchema: { type: 'object' }, errorSchema: { type: 'object' }, semantics: '只允许读取当前隔离工作区内的文件' }, constraints: { permissions: ['workspace.read'], sideEffects: 'read', isolation: 'per_runtime_instance' }, preferredTargetCapability: null, consumerTools: ['review_document'], evidence: [{ path: 'tools/review.py', line: 8, detail: 'text = context.read_document(path)' }] }],
});
const capabilities = JSON.parse(await readFile(path.resolve('contracts/runtime-launcher/examples/builder-capabilities.json'), 'utf8'));
const launcher = {
  schemaVersion: 'finance.runtime-launcher-descriptor.v1' as const,
  deploymentId: 'builder-job-example-runtime', baseUrl: 'https://runtime.example.test/deployments/builder-job-example-runtime/',
  runtime: { type: 'openjiuwen', version: '1.2.0' }, protocols: requirements.target.protocols,
  authentication: { type: 'bearer' as const, audience: 'finance-skill-eval' }, artifactSha256: '8cf0d0a4a1d6de50c0768606ae7d4179a64ac42190d7a2c12517d88b101ad79d',
  capabilitiesDigest: canonicalSha256(capabilities), expiresAt: '2026-10-01T12:00:00.000Z',
};
const common = { schemaVersion: 'finance.runtime-build-result.v1' as const, buildId: 'build-example', requestId: requirements.requestId, requirementsDigest: requirements.requirementsDigest, builder: { name: 'example-builder', version: '1.0.0' }, builtAt: '2026-09-29T12:00:00.000Z' };
const implemented = { requirementId: 'harness-1-read-document', status: 'IMPLEMENTED' as const, capabilityId: 'workspace.read_document', contractDigest: canonicalSha256(requirements.requiredCapabilities[0]!.contract), verificationIds: ['contract-read-document'] };
const verification = { id: 'contract-read-document', type: 'CONTRACT_TEST', status: 'PASSED' as const, evidenceSha256: 'b'.repeat(64) };
const success = withResultDigest({ ...common, status: 'SUCCEEDED', launcher, capabilityResults: [implemented], verifications: [verification], errors: [] });
const partial = withResultDigest({ ...common, status: 'PARTIAL', launcher: null, capabilityResults: [{ requirementId: implemented.requirementId, status: 'UNSUPPORTED', verificationIds: [] }], verifications: [], errors: [{ code: 'CAPABILITY_UNSUPPORTED', requirementId: implemented.requirementId, message: '目标 Runtime 尚未提供受限文件读取', retryable: false }] });
const failed = withResultDigest({ ...common, status: 'FAILED', launcher: null, capabilityResults: [{ requirementId: implemented.requirementId, status: 'FAILED', verificationIds: ['contract-read-document'] }], verifications: [{ ...verification, status: 'FAILED' }], errors: [{ code: 'VERIFICATION_FAILED', requirementId: implemented.requirementId, message: '合同测试未通过', retryable: true }] });
const incomplete = { schemaVersion: 'finance.runtime-build-requirements.v1', status: 'INCOMPLETE_REQUIREMENTS', missing: [{ name: 'read_document', fields: ['contract', 'constraints'] }], message: '补齐机器可校验合同后才能生成构建请求' };
for (const [name, value] of Object.entries({ 'requirements.success.json': requirements, 'result.success.json': success, 'result.partial.json': partial, 'result.failed.json': failed, 'requirements.incomplete.json': incomplete })) await writeFile(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
