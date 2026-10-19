import { z } from "zod";
import { canonicalSha256 } from "../json-canonicalization.js";
import {capabilityContractSchema,capabilityConstraintsSchema as constraintsSchema} from './runtime-capability.js';
import { runtimeLauncherCapabilitiesSchema, runtimeLauncherDescriptorSchema, validateRuntimeLauncherDelivery } from "./runtime-launcher.js";
import {
  RUNTIME_CAPABILITIES_SCHEMA_VERSION,
  RUNTIME_EXECUTION_SCHEMA_VERSION,
  RUNTIME_INSTANCE_SCHEMA_VERSION,
  LEGACY_RUNTIME_INSTANCE_SCHEMA_VERSION,
  RUNTIME_OBSERVATION_SCHEMA_VERSION,
} from "./runtime-protocol-versions.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const protocolsSchema = z.strictObject({
  capabilities: z.literal(RUNTIME_CAPABILITIES_SCHEMA_VERSION),
  instance: z.enum([LEGACY_RUNTIME_INSTANCE_SCHEMA_VERSION, RUNTIME_INSTANCE_SCHEMA_VERSION]),
  execution: z.literal(RUNTIME_EXECUTION_SCHEMA_VERSION),
  observation: z.literal(RUNTIME_OBSERVATION_SCHEMA_VERSION),
});
export const capabilityRequirementSchema = z.strictObject({
  id: z.string().min(1), name: z.string().min(1), required: z.boolean(), reason: z.string().min(1),
  contract: capabilityContractSchema, constraints: constraintsSchema,
  preferredTargetCapability: z.string().min(1).nullable(), consumerTools: z.array(z.string().min(1)),
  evidence: z.array(z.strictObject({ path: z.string().min(1), line: z.number().int().positive(), detail: z.string().min(1) })),
});

export const runtimeBuildRequirementsSchema = z.strictObject({
  schemaVersion: z.enum(["finance.runtime-build-requirements.v1", "finance.runtime-build-requirements.v2"]),
  requestId: z.string().min(1),
  source: z.strictObject({ assetId: z.string().min(1), artifactSha256: sha256 }),
  target: z.strictObject({ runtimeType: z.string().min(1), protocols: protocolsSchema }),
  requiredCapabilities: z.array(capabilityRequirementSchema),
  rebuild: z.strictObject({
    baseline: z.strictObject({deploymentId:z.string().min(1),artifactSha256:sha256,solutionRevisionId:sha256}),
    hypothesis: z.strictObject({id:z.string().min(1),issue:z.string().min(1).max(2000),expectedBehavior:z.string().min(1).max(2000)}),
    evidence: z.array(z.strictObject({jobId:z.string().min(1),caseId:z.string().min(1).optional(),summary:z.string().min(1).max(1000)})).min(1).max(20),
  }).optional(),
  requirementsDigest: sha256,
  extensions: z.record(z.unknown()).optional(),
}).superRefine((value, context) => {
  const expected = value.schemaVersion.endsWith('.v2') ? RUNTIME_INSTANCE_SCHEMA_VERSION : LEGACY_RUNTIME_INSTANCE_SCHEMA_VERSION;
  if(value.target.protocols.instance!==expected) context.addIssue({code:'custom',path:['target','protocols','instance'],message:'Instance protocol must match build protocol version'});
  const ids = new Set<string>();
  value.requiredCapabilities.forEach((item, index) => {
    if (ids.has(item.id)) context.addIssue({ code: "custom", path: ["requiredCapabilities", index, "id"], message: "Capability requirement IDs must be unique" });
    ids.add(item.id);
  });
});

const buildErrorSchema = z.strictObject({
  code: z.enum(["INVALID_REQUIREMENTS", "UNSUPPORTED_SCHEMA_VERSION", "UNSUPPORTED_TARGET_PROTOCOL", "CAPABILITY_UNSUPPORTED", "CONTRACT_INCOMPATIBLE", "BUILD_FAILED", "VERIFICATION_FAILED", "DEPLOYMENT_FAILED", "LAUNCHER_UNAVAILABLE", "INTERNAL_ERROR"]),
  requirementId: z.string().min(1).optional(), message: z.string().min(1), retryable: z.boolean(),
});

export const runtimeBuildResultSchema = z.strictObject({
  schemaVersion: z.enum(["finance.runtime-build-result.v1", "finance.runtime-build-result.v2"]), buildId: z.string().min(1), requestId: z.string().min(1), requirementsDigest: sha256,
  status: z.enum(["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"]),
  builder: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  launcher: runtimeLauncherDescriptorSchema.nullable(),
  capabilityResults: z.array(z.strictObject({ requirementId: z.string().min(1), status: z.enum(["IMPLEMENTED", "UNSUPPORTED", "FAILED"]), capabilityId: z.string().min(1).optional(), contractDigest: sha256.optional(), verificationIds: z.array(z.string().min(1)) })),
  verifications: z.array(z.strictObject({ id: z.string().min(1), type: z.string().min(1), status: z.enum(["PASSED", "FAILED", "NOT_RUN"]), evidenceSha256: sha256.optional() })),
  errors: z.array(buildErrorSchema), builtAt: z.string().datetime(), resultDigest: sha256,
  extensions: z.record(z.unknown()).optional(),
}).superRefine((value, context) => {
  if (value.status === "SUCCEEDED" && !value.launcher) context.addIssue({ code: "custom", path: ["launcher"], message: "A successful build must return a deployed Launcher" });
  if (value.status !== "SUCCEEDED" && value.launcher) context.addIssue({ code: "custom", path: ["launcher"], message: "An unsuccessful build must not return an active Launcher" });
});

export type RuntimeBuildRequirements = z.infer<typeof runtimeBuildRequirementsSchema>;
/** Legacy import alias; new code uses RuntimeBuildRequirements. */
export type RuntimeBuildRequirementsV1 = RuntimeBuildRequirements;
export type RuntimeBuildResult = z.infer<typeof runtimeBuildResultSchema>;
/** Legacy import alias; new code uses RuntimeBuildResult. */
export type RuntimeBuildResultV1 = RuntimeBuildResult;

export function withRequirementsDigest(input: Omit<RuntimeBuildRequirementsV1, "requirementsDigest">): RuntimeBuildRequirementsV1 {
  return runtimeBuildRequirementsSchema.parse({ ...input, requirementsDigest: canonicalSha256(input) });
}

export function withResultDigest(input: Omit<RuntimeBuildResultV1, "resultDigest">): RuntimeBuildResultV1 {
  return runtimeBuildResultSchema.parse({ ...input, resultDigest: canonicalSha256(input) });
}

export function validateRuntimeBuildResult(requirementsInput: unknown, resultInput: unknown, capabilitiesInput?: unknown): string[] {
  const requirements = runtimeBuildRequirementsSchema.parse(requirementsInput);
  const result = runtimeBuildResultSchema.parse(resultInput);
  const issues: string[] = [];
  const { requirementsDigest: _requirementsDigest, ...requirementsBody } = requirements;
  const { resultDigest: _resultDigest, ...resultBody } = result;
  if (requirements.requirementsDigest !== canonicalSha256(requirementsBody)) issues.push("INVALID_REQUIREMENTS_DIGEST");
  if (result.resultDigest !== canonicalSha256(resultBody)) issues.push("INVALID_RESULT_DIGEST");
  if (result.schemaVersion !== requirements.schemaVersion.replace("requirements", "result")) issues.push("RESULT_SCHEMA_VERSION_MISMATCH");
  if (result.requestId !== requirements.requestId) issues.push("REQUEST_ID_MISMATCH");
  if (result.requirementsDigest !== requirements.requirementsDigest) issues.push("REQUIREMENTS_DIGEST_MISMATCH");
  if (result.status !== "SUCCEEDED") issues.push(`BUILD_STATUS_${result.status}`);
  if (result.errors.length) issues.push("BUILD_ERRORS_PRESENT");
  const requirementIds = new Set(requirements.requiredCapabilities.map(item => item.id));
  const resultCounts = new Map<string, number>();
  for (const item of result.capabilityResults) {
    resultCounts.set(item.requirementId, (resultCounts.get(item.requirementId) ?? 0) + 1);
    if (!requirementIds.has(item.requirementId)) issues.push(`UNKNOWN_REQUIREMENT_${item.requirementId}`);
  }
  const verifications = new Map(result.verifications.map(item => [item.id, item]));
  for (const requirement of requirements.requiredCapabilities.filter(item => item.required)) {
    const matches = result.capabilityResults.filter(item => item.requirementId === requirement.id);
    if (matches.length !== 1) { issues.push(`REQUIREMENT_RESULT_COUNT_${requirement.id}`); continue; }
    const match = matches[0]!;
    if (match.status !== "IMPLEMENTED") issues.push(`REQUIREMENT_NOT_IMPLEMENTED_${requirement.id}`);
    if (match.contractDigest !== canonicalSha256(requirement.contract)) issues.push(`CONTRACT_INCOMPATIBLE_${requirement.id}`);
    if (!match.verificationIds.length || match.verificationIds.some(id => verifications.get(id)?.status !== "PASSED")) issues.push(`VERIFICATION_NOT_PASSED_${requirement.id}`);
  }
  for (const [id, count] of resultCounts) if (count > 1) issues.push(`DUPLICATE_REQUIREMENT_${id}`);
  if (!result.launcher) issues.push("LAUNCHER_UNAVAILABLE");
  else {
    if(requirements.rebuild?.baseline.deploymentId===result.launcher.deploymentId)issues.push('REBUILD_DEPLOYMENT_UNCHANGED');
    if(requirements.rebuild?.baseline.artifactSha256===result.launcher.artifactSha256)issues.push('REBUILD_ARTIFACT_UNCHANGED');
    if (result.launcher.runtime.type !== requirements.target.runtimeType) issues.push("RUNTIME_TYPE_MISMATCH");
    for (const [name, expected] of Object.entries(requirements.target.protocols)) {
      if (result.launcher.protocols[name as keyof typeof result.launcher.protocols] !== expected) issues.push(`PROTOCOL_MISMATCH_${name.toUpperCase()}`);
    }
    if (capabilitiesInput === undefined) issues.push("CAPABILITIES_NOT_PROVIDED");
    else {
      const capabilities = runtimeLauncherCapabilitiesSchema.parse(capabilitiesInput);
      if(requirements.schemaVersion.endsWith('.v2') && capabilities.features.multiSkill!==true)issues.push('INLINE_SKILLS_NOT_SUPPORTED');
      issues.push(...validateRuntimeLauncherDelivery(result.launcher, capabilities).map(issue => `LAUNCHER_${issue}`));
    }
  }
  return [...new Set(issues)];
}
