import { z } from "zod";
import { canonicalSha256 } from "../json-canonicalization.js";
import { runtimeObservationCapabilitiesSchema } from "./runtime-observation.js";
import {nativeCapabilitySchema} from './runtime-capability.js';
import {
  RUNTIME_CAPABILITIES_SCHEMA_VERSION,
  RUNTIME_EXECUTION_SCHEMA_VERSION,
  RUNTIME_INSTANCE_SCHEMA_VERSION,
  RUNTIME_LAUNCHER_DESCRIPTOR_SCHEMA_VERSION,
  RUNTIME_OBSERVATION_SCHEMA_VERSION,
} from "./runtime-protocol-versions.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const runtimeLauncherBaseUrlSchema = z.string().url().transform(value => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error("Runtime Launcher base URL is invalid");
  }
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Remote Runtime Launcher requires HTTPS");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
});

const publicModelSchema = z.strictObject({
  modelId: z.string().min(1),
  upstreamModelId: z.string().min(1),
  label: z.string().min(1).optional(),
});

export const runtimeLauncherCapabilitiesSchema = z.strictObject({
  schemaVersion: z.literal(RUNTIME_CAPABILITIES_SCHEMA_VERSION),
  runtime: z.strictObject({ type: z.string().min(1), version: z.string().min(1) }),
  models: z.array(publicModelSchema).min(1),
  defaultModelId: z.string().min(1),
  supportedSkillModes: z.array(z.enum(["skill_version", "without_target_skill"])).min(1).optional(),
  nativeToolNames: z.array(z.string().min(1)).optional(),
  nativeCapabilities:z.array(nativeCapabilitySchema).optional(),
  observability: runtimeObservationCapabilitiesSchema.optional(),
  features: z.strictObject({
    streaming: z.boolean(), asyncLaunch: z.boolean(), packagedMcp: z.boolean(),
    externalMcp: z.boolean(), inlineSecrets: z.boolean(),
    multiTurn:z.boolean().optional(),
  }),
  limits: z.strictObject({
    maxArchiveBytes: z.number().int().positive(), maxFiles: z.number().int().positive(),
    maxTimeoutMs: z.number().int().positive(), maxConcurrentInstances: z.number().int().positive(),
  }),
}).superRefine((value, context) => {
  for(const field of ['capabilityId','name'] as const){
    const values=(value.nativeCapabilities??[]).map(item=>item[field]);
    if(new Set(values).size!==values.length)context.addIssue({code:'custom',path:['nativeCapabilities'],message:`Duplicate native capability ${field}`});
  }
  if(value.nativeCapabilities?.some(item=>!value.nativeToolNames?.includes(item.name)))context.addIssue({code:'custom',path:['nativeCapabilities'],message:'Native capability must be an advertised native tool'});
  if (!value.models.some(model => model.modelId === value.defaultModelId)) {
    context.addIssue({ code: "custom", message: "Default model is not advertised" });
  }
});

export type RuntimeLauncherCapabilities = z.infer<typeof runtimeLauncherCapabilitiesSchema>;

const authenticationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("bearer"), audience: z.string().min(1).optional() }),
]);

export const runtimeLauncherDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(RUNTIME_LAUNCHER_DESCRIPTOR_SCHEMA_VERSION),
  deploymentId: z.string().min(1),
  baseUrl: runtimeLauncherBaseUrlSchema,
  runtime: z.strictObject({ type: z.string().min(1), version: z.string().min(1) }),
  protocols: z.strictObject({
    capabilities: z.literal(RUNTIME_CAPABILITIES_SCHEMA_VERSION),
    instance: z.literal(RUNTIME_INSTANCE_SCHEMA_VERSION),
    execution: z.literal(RUNTIME_EXECUTION_SCHEMA_VERSION),
    observation: z.literal(RUNTIME_OBSERVATION_SCHEMA_VERSION),
  }),
  authentication: authenticationSchema,
  artifactSha256: sha256,
  capabilitiesDigest: sha256,
  expiresAt: z.string().datetime().nullable(),
});

export type RuntimeLauncherDescriptor = z.infer<typeof runtimeLauncherDescriptorSchema>;

export function validateRuntimeLauncherDelivery(descriptorInput: unknown, capabilitiesInput: unknown): string[] {
  const descriptor = runtimeLauncherDescriptorSchema.parse(descriptorInput);
  const capabilities = runtimeLauncherCapabilitiesSchema.parse(capabilitiesInput);
  const issues: string[] = [];
  if (capabilities.runtime.type !== descriptor.runtime.type) issues.push("RUNTIME_TYPE_MISMATCH");
  if (capabilities.runtime.version !== descriptor.runtime.version) issues.push("RUNTIME_VERSION_MISMATCH");
  if (canonicalSha256(capabilities) !== descriptor.capabilitiesDigest) issues.push("CAPABILITIES_DIGEST_MISMATCH");
  if (!capabilities.observability) issues.push("OBSERVABILITY_NOT_DECLARED");
  return issues;
}
