import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const nonnegativeInteger = z.number().int().nonnegative();
export const RUNTIME_OBSERVATION_LIMITS = {
  identifierCharacters: 200,
  messageCharacters: 4_096,
  outputDeltaCharacters: 16_384,
  nativeSerializedBytes: 32_768,
  eventSerializedBytes: 65_536,
  nativeDepth: 8,
} as const;
const identifier = z.string().min(1).max(RUNTIME_OBSERVATION_LIMITS.identifierCharacters);

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
  code: identifier,
  message: z.string().min(1).max(RUNTIME_OBSERVATION_LIMITS.messageCharacters),
  retryable: z.boolean(),
});

const usageSchema = z.strictObject({
  inputTokens: nonnegativeInteger.optional(),
  outputTokens: nonnegativeInteger.optional(),
  totalTokens: nonnegativeInteger.optional(),
});

const sourceSchema = z.strictObject({
  adapter: identifier,
  framework: identifier.optional(),
  frameworkVersion: identifier.optional(),
  nativeEventType: identifier.optional(),
  synthesized: z.boolean(),
});

const envelope = {
  schemaVersion: z.literal("finance.runtime-observation.v1"),
  eventId: identifier,
  sequence: nonnegativeInteger,
  occurredAt: z.string().datetime(),
  traceId: identifier,
  instanceId: identifier,
  runId: identifier.optional(),
  caseId: identifier.optional(),
  side: z.enum(["left", "right"]).optional(),
  source: sourceSchema,
  native: z.strictObject({ data: z.unknown() }).optional(),
};

const lifecyclePayloadSchema = z.strictObject({
  message: z.string().min(1).max(RUNTIME_OBSERVATION_LIMITS.messageCharacters).optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  error: errorSchema.optional(),
  evidenceDigest: sha256.optional(),
});

const skillPayloadSchema = z.strictObject({
  skillId: identifier,
  version: identifier.optional(),
  artifactSha256: sha256.optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  error: errorSchema.optional(),
});

const mcpPayloadSchema = z.strictObject({
  serverId: identifier,
  durationMs: z.number().finite().nonnegative().optional(),
  error: errorSchema.optional(),
});

const modelPayloadSchema = z.strictObject({
  modelCallId: identifier,
  modelId: identifier,
  durationMs: z.number().finite().nonnegative().optional(),
  usage: usageSchema.optional(),
  error: errorSchema.optional(),
});

const toolPayloadSchema = z.strictObject({
  toolCallId: identifier,
  name: identifier,
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
  z.strictObject({ ...envelope, kind: z.literal("output.delta"), payload: z.strictObject({ text: z.string().max(RUNTIME_OBSERVATION_LIMITS.outputDeltaCharacters) }) }),
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
  const serializedBytes = jsonBytes(value);
  if(serializedBytes===null)context.addIssue({code:"custom",message:"Observation event must be JSON serializable"});
  else if (serializedBytes > RUNTIME_OBSERVATION_LIMITS.eventSerializedBytes) {
    context.addIssue({ code: "custom", message: `Observation event exceeds ${RUNTIME_OBSERVATION_LIMITS.eventSerializedBytes} serialized bytes` });
  }
  if (value.native) validateNativeData(value.native.data, context);
});

const sensitiveNativeKey = /(?:^|-)(?:authorization|api-key|apikey|access-token|refresh-token|bearer-token|token|password|secret|cookie|reasoning|chain-of-thought|hidden-thought|prompt|body|payload|content|text|input|output|request|response|messages|request-body|response-body|raw-input|raw-output)(?:$|-)/u;
function normalizeNativeKey(key:string):string{return key.normalize('NFKC')
  .replace(/([a-z0-9])([A-Z])/gu,'$1-$2').replace(/[_\s.]+/gu,'-').replace(/-+/gu,'-').replace(/^-|-$/gu,'').toLowerCase();}
function jsonBytes(value:unknown):number|null{try{const serialized=JSON.stringify(value);return serialized===undefined?null:new TextEncoder().encode(serialized).byteLength;}catch{return null;}}
function validateNativeData(value: unknown, context: z.RefinementCtx): void {
  const bytes=jsonBytes(value);
  if(bytes===null){context.addIssue({code:"custom",path:["native","data"],message:"Native data must be JSON"});return;}
  if (bytes > RUNTIME_OBSERVATION_LIMITS.nativeSerializedBytes) {
    context.addIssue({ code: "custom", path: ["native", "data"], message: `Native data exceeds ${RUNTIME_OBSERVATION_LIMITS.nativeSerializedBytes} serialized bytes` });
  }
  const pending:Array<{item:unknown;depth:number;path:Array<string|number>}>= [{item:value,depth:1,path:[]}];
  while(pending.length){
    const {item,depth,path}=pending.pop()!;
    if (depth > RUNTIME_OBSERVATION_LIMITS.nativeDepth) {
      context.addIssue({ code: "custom", path: ["native", "data", ...path], message: `Native data exceeds maximum depth ${RUNTIME_OBSERVATION_LIMITS.nativeDepth}` });
      continue;
    }
    if(item===null||typeof item==="string"||typeof item==="boolean")continue;
    if(typeof item==="number"){if(!Number.isFinite(item))context.addIssue({code:"custom",path:["native","data",...path],message:"Native data must contain finite JSON numbers"});continue;}
    if (Array.isArray(item)) item.forEach((child, index) => pending.push({item:child,depth:depth+1,path:[...path,index]}));
    else if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) {
      const normalizedKey=normalizeNativeKey(key);
      if (sensitiveNativeKey.test(normalizedKey)) context.addIssue({ code: "custom", path: ["native", "data", ...path, key], message: "Native data contains a forbidden sensitive field" });
      pending.push({item:child,depth:depth+1,path:[...path,key]});
    } else context.addIssue({code:"custom",path:["native","data",...path],message:"Native data must be JSON"});
  }
}

export type RuntimeObservationEvent = z.infer<typeof runtimeObservationEventSchema>;

