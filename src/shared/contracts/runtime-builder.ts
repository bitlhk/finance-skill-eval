import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalSha256 } from "../json-canonicalization.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const jsonSchema = z.record(z.unknown());
const protocolsSchema = z.strictObject({ registration: z.string().min(1), instance: z.string().min(1), execution: z.string().min(1) });
const capabilityContractSchema = z.strictObject({ inputSchema: jsonSchema, outputSchema: jsonSchema, errorSchema: jsonSchema, semantics: z.string().min(1) });
const constraintsSchema = z.strictObject({ permissions: z.array(z.string().min(1)), sideEffects: z.enum(["none", "read", "write"]), isolation: z.string().min(1) });

export const runtimeBuildRequirementsSchema = z.strictObject({
  schemaVersion: z.literal("finance.runtime-build-requirements.v1"),
  requestId: z.string().min(1),
  source: z.strictObject({ assetId: z.string().min(1), artifactSha256: sha256 }),
  target: z.strictObject({ runtimeType: z.string().min(1), protocols: protocolsSchema }),
  requiredCapabilities: z.array(z.strictObject({
    id: z.string().min(1), name: z.string().min(1), required: z.boolean(), reason: z.string().min(1),
    contract: capabilityContractSchema, constraints: constraintsSchema,
    preferredTargetCapability: z.string().min(1).nullable(), consumerTools: z.array(z.string().min(1)),
    evidence: z.array(z.strictObject({ path: z.string().min(1), line: z.number().int().positive(), detail: z.string().min(1) })),
  })),
  requirementsDigest: sha256,
  extensions: z.record(z.unknown()).optional(),
}).superRefine((value,context)=>{
  const ids=new Set<string>();
  value.requiredCapabilities.forEach((item,index)=>{if(ids.has(item.id))context.addIssue({code:'custom',path:['requiredCapabilities',index,'id'],message:'Capability requirement IDs must be unique'});ids.add(item.id);});
});

const buildErrorSchema = z.strictObject({
  code: z.enum(["INVALID_REQUIREMENTS", "UNSUPPORTED_SCHEMA_VERSION", "UNSUPPORTED_TARGET_PROTOCOL", "CAPABILITY_UNSUPPORTED", "CONTRACT_INCOMPATIBLE", "BUILD_FAILED", "VERIFICATION_FAILED", "ARTIFACT_UNAVAILABLE", "INTERNAL_ERROR"]),
  requirementId: z.string().min(1).optional(), message: z.string().min(1), retryable: z.boolean(),
});

export const runtimeBuildResultSchema = z.strictObject({
  schemaVersion: z.literal("finance.runtime-build-result.v1"), buildId: z.string().min(1), requestId: z.string().min(1), requirementsDigest: sha256,
  status: z.enum(["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"]),
  builder: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  artifact: z.strictObject({ mediaType: z.string().min(1), uri: z.string().min(1).refine(value=>{try{const url=new URL(value);return !url.username&&!url.password;}catch{return false;}},'Artifact URI must be absolute and must not contain credentials'), sha256, sbomSha256: sha256.optional() }).nullable(),
  runtime: z.strictObject({ runtimeType: z.string().min(1), version: z.string().min(1), protocols: protocolsSchema,
    requiredConfiguration: z.array(z.strictObject({ name: z.string().min(1), type: z.enum(["string", "number", "boolean"]), required: z.boolean(), sensitive: z.boolean() })) }),
  capabilityResults: z.array(z.strictObject({ requirementId: z.string().min(1), status: z.enum(["IMPLEMENTED", "UNSUPPORTED", "FAILED"]), capabilityId: z.string().min(1).optional(), contractDigest: sha256.optional(), verificationIds: z.array(z.string().min(1)) })),
  verifications: z.array(z.strictObject({ id: z.string().min(1), type: z.string().min(1), status: z.enum(["PASSED", "FAILED", "NOT_RUN"]), evidenceSha256: sha256.optional() })),
  errors: z.array(buildErrorSchema), builtAt: z.string().datetime(), resultDigest: sha256,
  extensions: z.record(z.unknown()).optional(),
});

export type RuntimeBuildRequirementsV1 = z.infer<typeof runtimeBuildRequirementsSchema>;
export type RuntimeBuildResultV1 = z.infer<typeof runtimeBuildResultSchema>;

export function withRequirementsDigest(input: Omit<RuntimeBuildRequirementsV1, "requirementsDigest">): RuntimeBuildRequirementsV1 {
  return runtimeBuildRequirementsSchema.parse({ ...input, requirementsDigest: canonicalSha256(input) });
}

export function withResultDigest(input: Omit<RuntimeBuildResultV1, "resultDigest">): RuntimeBuildResultV1 {
  return runtimeBuildResultSchema.parse({ ...input, resultDigest: canonicalSha256(input) });
}

export function validateRuntimeBuildResult(requirementsInput: unknown, resultInput: unknown, artifact?: Uint8Array): string[] {
  const requirements = runtimeBuildRequirementsSchema.parse(requirementsInput);
  const result = runtimeBuildResultSchema.parse(resultInput);
  const issues: string[] = [];
  const { requirementsDigest: _requirementsDigest, ...requirementsBody } = requirements;
  const { resultDigest: _resultDigest, ...resultBody } = result;
  const expectedRequirementsDigest = canonicalSha256(requirementsBody);
  const expectedResultDigest = canonicalSha256(resultBody);
  if (requirements.requirementsDigest !== expectedRequirementsDigest) issues.push("INVALID_REQUIREMENTS_DIGEST");
  if (result.resultDigest !== expectedResultDigest) issues.push("INVALID_RESULT_DIGEST");
  if (result.requestId !== requirements.requestId) issues.push("REQUEST_ID_MISMATCH");
  if (result.requirementsDigest !== requirements.requirementsDigest) issues.push("REQUIREMENTS_DIGEST_MISMATCH");
  if (result.status !== "SUCCEEDED") issues.push(`BUILD_STATUS_${result.status}`);
  if (result.errors.length) issues.push("BUILD_ERRORS_PRESENT");
  if (result.runtime.runtimeType !== requirements.target.runtimeType) issues.push("RUNTIME_TYPE_MISMATCH");
  for (const [name, expected] of Object.entries(requirements.target.protocols)) if (result.runtime.protocols[name as keyof typeof result.runtime.protocols] !== expected) issues.push(`PROTOCOL_MISMATCH_${name.toUpperCase()}`);
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
  if (!result.artifact) issues.push("ARTIFACT_UNAVAILABLE");
  else if (!artifact) issues.push("ARTIFACT_NOT_PROVIDED");
  else if (createHash("sha256").update(artifact).digest("hex") !== result.artifact.sha256) issues.push("ARTIFACT_DIGEST_MISMATCH");
  return [...new Set(issues)];
}
