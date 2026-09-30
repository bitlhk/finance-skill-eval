import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const nonnegativeInteger = z.number().int().nonnegative();

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(jsonValueSchema), z.record(jsonValueSchema),
]));

export const runtimeObservationKindSchema = z.enum([
  "execution.started", "execution.completed", "execution.failed",
  "runtime.instance.started", "runtime.instance.ready", "runtime.instance.failed",
  "skill.load.started", "skill.load.completed", "skill.load.failed",
  "mcp.start.started", "mcp.start.completed", "mcp.start.failed",
  "model.call.started", "model.call.completed", "model.call.failed",
  "tool.call.started", "tool.call.completed", "tool.call.failed",
  "output.delta", "usage.reported",
]);

export type RuntimeObservationKind = z.infer<typeof runtimeObservationKindSchema>;

const coreKinds = ["execution.started", "execution.completed", "execution.failed"] as const;
const toolKinds = [
  ...coreKinds,
  "model.call.started", "model.call.completed", "model.call.failed",
  "tool.call.started", "tool.call.completed", "tool.call.failed",
] as const;

export const runtimeObservationCapabilitiesSchema = z.strictObject({
  schemaVersion: z.literal("finance.runtime-observation-capabilities.v1"),
  profile: z.enum(["core", "tool", "detailed"]),
  supportedKinds: z.array(runtimeObservationKindSchema).min(3),
  nativeEvents: z.boolean(),
  replayable: z.boolean(),
}).superRefine((value, context) => {
  const kinds = new Set(value.supportedKinds);
  if (kinds.size !== value.supportedKinds.length) {
    context.addIssue({ code: "custom", path: ["supportedKinds"], message: "Observation kinds must be unique" });
  }
  const required = value.profile === "core" ? coreKinds : toolKinds;
  for (const kind of required) {
    if (!kinds.has(kind)) context.addIssue({ code: "custom", path: ["supportedKinds"], message: `${value.profile} profile requires ${kind}` });
  }
  if (value.profile === "detailed" && !value.nativeEvents) {
    context.addIssue({ code: "custom", path: ["nativeEvents"], message: "Detailed profile requires native event extensions" });
  }
});

export type RuntimeObservationCapabilities = z.infer<typeof runtimeObservationCapabilitiesSchema>;

const errorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});

const usageSchema = z.strictObject({
  inputTokens: nonnegativeInteger.optional(),
  outputTokens: nonnegativeInteger.optional(),
  totalTokens: nonnegativeInteger.optional(),
});

const sourceSchema = z.strictObject({
  adapter: z.string().min(1),
  framework: z.string().min(1).optional(),
  frameworkVersion: z.string().min(1).optional(),
  nativeEventType: z.string().min(1).optional(),
  synthesized: z.boolean(),
});

const envelope = {
  schemaVersion: z.literal("finance.runtime-observation.v1"),
  eventId: z.string().min(1),
  sequence: nonnegativeInteger,
  occurredAt: z.string().datetime(),
  traceId: z.string().min(1),
  instanceId: z.string().min(1),
  runId: z.string().min(1).optional(),
  caseId: z.string().min(1).optional(),
  side: z.enum(["left", "right"]).optional(),
  source: sourceSchema,
  native: z.strictObject({ data: jsonValueSchema }).optional(),
};

const lifecyclePayloadSchema = z.strictObject({
  message: z.string().min(1).optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  error: errorSchema.optional(),
  evidenceDigest: sha256.optional(),
});

const skillPayloadSchema = z.strictObject({
  skillId: z.string().min(1),
  version: z.string().min(1).optional(),
  artifactSha256: sha256.optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  error: errorSchema.optional(),
});

const mcpPayloadSchema = z.strictObject({
  serverId: z.string().min(1),
  durationMs: z.number().finite().nonnegative().optional(),
  error: errorSchema.optional(),
});

const modelPayloadSchema = z.strictObject({
  modelCallId: z.string().min(1),
  modelId: z.string().min(1),
  durationMs: z.number().finite().nonnegative().optional(),
  usage: usageSchema.optional(),
  error: errorSchema.optional(),
});

const toolPayloadSchema = z.strictObject({
  toolCallId: z.string().min(1),
  name: z.string().min(1),
  durationMs: z.number().finite().nonnegative().optional(),
  inputDigest: sha256.optional(),
  outputDigest: sha256.optional(),
  error: errorSchema.optional(),
});

const eventSchemas = [
  z.strictObject({ ...envelope, kind: z.enum(["execution.started", "execution.completed", "execution.failed"]), payload: lifecyclePayloadSchema }),
  z.strictObject({ ...envelope, kind: z.enum(["runtime.instance.started", "runtime.instance.ready", "runtime.instance.failed"]), payload: lifecyclePayloadSchema }),
  z.strictObject({ ...envelope, kind: z.enum(["skill.load.started", "skill.load.completed", "skill.load.failed"]), payload: skillPayloadSchema }),
  z.strictObject({ ...envelope, kind: z.enum(["mcp.start.started", "mcp.start.completed", "mcp.start.failed"]), payload: mcpPayloadSchema }),
  z.strictObject({ ...envelope, kind: z.enum(["model.call.started", "model.call.completed", "model.call.failed"]), payload: modelPayloadSchema }),
  z.strictObject({ ...envelope, kind: z.enum(["tool.call.started", "tool.call.completed", "tool.call.failed"]), payload: toolPayloadSchema }),
  z.strictObject({ ...envelope, kind: z.literal("output.delta"), payload: z.strictObject({ text: z.string() }) }),
  z.strictObject({ ...envelope, kind: z.literal("usage.reported"), payload: usageSchema }),
] as const;

export const runtimeObservationEventSchema = z.union(eventSchemas).superRefine((value, context) => {
  if (value.native && !value.source.nativeEventType) {
    context.addIssue({ code: "custom", path: ["source", "nativeEventType"], message: "Native data requires its framework event type" });
  }
  if ((value.kind.startsWith("execution.") || value.kind.startsWith("model.") || value.kind.startsWith("tool.") || value.kind.startsWith("output.") || value.kind === "usage.reported")
      && (!value.runId || !value.caseId || !value.side)) {
    context.addIssue({ code: "custom", message: "Execution events require runId, caseId and side" });
  }
});

export type RuntimeObservationEvent = z.infer<typeof runtimeObservationEventSchema>;

