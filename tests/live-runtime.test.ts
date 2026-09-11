import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpRuntimeAdapter } from "../src/http-runtime.js";
import { evalCaseSchema, runtimeExecutionEvidenceSchema } from "../src/contracts.js";
import { preflightMcpServer } from "../src/mcp-preflight.js";

afterEach(() => vi.unstubAllGlobals());
const evalCase = evalCaseSchema.parse({ caseId: "LIVE-1", name: "live", prompt: "task", evaluationGoal: "secret scoring instructions", rubric: [{ criterionId: "fact", label: "facts", description: "secret", dimension: "professional_fit", weight: 1 }], replay: { evidenceFile: "answers.json", sourcePromptId: "secret" } });
const evidence = runtimeExecutionEvidenceSchema.parse({ runId: "run", side: "left", caseId: "LIVE-1", status: "completed", modelId: "model", skillVersion: null, output: "你好", elapsedMs: 10, runtimeIdentityVerified: true, streamCompleted: true, error: null });
const input = { runId: "run", side: "left" as const, evalCase, model: { providerId: "test", modelId: "model", parameters: {} }, variant: { mode: "without_target_skill" as const, skillId: "skill" } };

describe("live runtime evidence", () => {
  it("streams deltas, handles split UTF-8, and never sends grading/replay fields to executor", async () => {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ type: "text_delta", text: "你好" })}\n\ndata: ${JSON.stringify({ evidence })}\n\n`);
    const response = new Response(new ReadableStream({ start(controller) { for (let i=0; i<bytes.length; i+=7) controller.enqueue(bytes.slice(i,i+7)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    const mock = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", mock);
    const events: unknown[] = [];
    const runtime = new HttpRuntimeAdapter({ adapterId: "test", endpoint: "http://localhost/execute" });
    expect((await runtime.execute({ ...input, onEvent: e => events.push(e) })).output).toBe("你好");
    expect(events).toEqual([expect.objectContaining({ type: "text_delta", text: "你好" })]);
    const sent = JSON.parse(mock.mock.calls[0]![1].body);
    expect(sent.case).not.toHaveProperty("rubric"); expect(sent.case).not.toHaveProperty("evaluationGoal"); expect(sent.case).not.toHaveProperty("replay");
  });
  it("rejects a truncated stream rather than calling it completed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('data: {"type":"status","text":"running"}\n\n', { headers: { "content-type": "text/event-stream" } })));
    await expect(new HttpRuntimeAdapter({ adapterId: "t", endpoint: "http://localhost/execute" }).execute(input)).rejects.toThrow(/without execution evidence/);
  });
  it("detects target Skill contamination in the baseline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...evidence, loadedSkills: [{ skillId: "skill", version: "1" }] }))));
    await expect(new HttpRuntimeAdapter({ adapterId: "t", endpoint: "http://localhost/execute" }).execute(input)).rejects.toThrow(/Baseline/);
  });
  it("initializes MCP properly and releases its preflight session", async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }), { headers: { "mcp-session-id": "session" } }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "read" }] } })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", mock);
    const result = await preflightMcpServer({ endpoint: "http://localhost/mcp" });
    expect(result.status).toBe("ready");
    expect(JSON.parse(mock.mock.calls[1]![1].body).method).toBe("notifications/initialized");
    expect(mock.mock.calls[3]![1].method).toBe("DELETE");
  });
});
