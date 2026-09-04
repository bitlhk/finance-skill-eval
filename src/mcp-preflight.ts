import { z } from "zod";

const jsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const toolListSchema = z.object({
  tools: z.array(z.object({
    name: z.string().min(1),
    description: z.string().optional(),
  }).passthrough()).default([]),
}).passthrough();

export type McpPreflightResult = {
  status: "ready" | "failed";
  protocolVersion: string | null;
  serverName: string | null;
  tools: Array<{ name: string; description?: string }>;
  elapsedMs: number;
  error: string | null;
};

function parseMcpPayload(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = trimmed
    .split(/\r?\n/u)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim())
    .find(line => line.startsWith("{"));
  if (!data) throw new Error("MCP response contained neither JSON nor SSE JSON data");
  return JSON.parse(data);
}

async function rpc(input: {
  endpoint: string;
  headers?: Record<string, string>;
  method: string;
  params: Record<string, unknown>;
  id: number;
  sessionId?: string | null;
}): Promise<{ payload: z.infer<typeof jsonRpcResponseSchema>; sessionId: string | null }> {
  const response = await fetch(input.endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(12_000),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(input.sessionId ? { "mcp-session-id": input.sessionId } : {}),
      ...input.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: input.id,
      method: input.method,
      params: input.params,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP ${input.method} failed with HTTP ${response.status}`);
  const payload = jsonRpcResponseSchema.parse(parseMcpPayload(text));
  if (payload.error) throw new Error(`${payload.error.code}: ${payload.error.message}`);
  return { payload, sessionId: response.headers.get("mcp-session-id") ?? input.sessionId ?? null };
}

export async function preflightMcpServer(input: {
  endpoint: string;
  headers?: Record<string, string>;
}): Promise<McpPreflightResult> {
  const startedAt = Date.now();
  try {
    const initialized = await rpc({
      ...input,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "finance-skill-eval", version: "0.3.1" },
      },
    });
    const initializeResult = z.object({
      protocolVersion: z.string().optional(),
      serverInfo: z.object({ name: z.string().optional() }).optional(),
    }).passthrough().parse(initialized.payload.result ?? {});
    const listed = await rpc({
      ...input,
      id: 2,
      method: "tools/list",
      params: {},
      sessionId: initialized.sessionId,
    });
    const tools = toolListSchema.parse(listed.payload.result ?? {}).tools.map(tool => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
    }));
    return {
      status: "ready",
      protocolVersion: initializeResult.protocolVersion ?? null,
      serverName: initializeResult.serverInfo?.name ?? null,
      tools,
      elapsedMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    return {
      status: "failed",
      protocolVersion: null,
      serverName: null,
      tools: [],
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
