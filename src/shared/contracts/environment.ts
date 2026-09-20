import { z } from "zod";

const endpointSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash;
}, "Use an HTTP(S) endpoint without embedded credentials or fragments");

export const createEnvironmentSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  type: z.enum(["mcp_streamable_http", "runtime_http"]),
  runtimeType: z.enum(["openjiuwen", "ea", "generic_http"]).nullable().optional(),
  endpoint: endpointSchema,
  credentialEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).max(100).nullable().optional(),
  mcpEnvironmentIds: z.array(z.string().min(1)).max(12).default([]),
}).superRefine((value, context) => {
  if (new Set(value.mcpEnvironmentIds).size !== value.mcpEnvironmentIds.length) {
    context.addIssue({ code: "custom", message: "Duplicate MCP bindings" });
  }
  if (value.type === "mcp_streamable_http" && value.mcpEnvironmentIds.length) {
    context.addIssue({ code: "custom", message: "An MCP service cannot bind other MCP services" });
  }
});

// Persisted records remain readable across releases; stricter validation applies to edits.
export const environmentRecordSchema = z.strictObject({
  environmentId: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["mcp_streamable_http", "runtime_http"]),
  runtimeType: z.enum(["openjiuwen", "ea", "generic_http"]).nullable().default(null),
  endpoint: z.string().url(),
  credentialEnv: z.string().min(1).nullable().default(null),
  mcpEnvironmentIds: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type EnvironmentRecord = z.infer<typeof environmentRecordSchema>;
