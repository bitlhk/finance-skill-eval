import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpRuntimeAdapter } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("HttpRuntimeAdapter", () => {
  it("preflights health and maps canonical execution evidence", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        runId: "external-run",
        side: "right",
        caseId: "HTTP-1",
        status: "completed",
        modelId: "glm-5.2",
        skillVersion: "1.0.0",
        output: "review result",
        elapsedMs: 42,
        toolCalls: [{ name: "risk_query", status: "completed" }],
        loadedSkills: [{ skillId: "risk-review", version: "1.0.0" }],
        usage: null,
        runtimeIdentityVerified: true,
        streamCompleted: true,
        error: null,
        metadata: {},
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new HttpRuntimeAdapter({
      adapterId: "test-http-runtime",
      endpoint: "https://agent.example/api/execute",
      environment: {
        environmentId: "openjiuwen-eval",
        harnessToolNames:['glob'],
        runtimeToolConfig: {context:{user:{type:'object',value:{id:'test-user'},sensitive:true}},providers:{},tools:{risk_query:{contextBindings:{'X-Business-User':'context.user'}}}},
        requiredToolNames: ["risk_query"],
        mcpServers: [{
          serverId: "risk-mcp",
          endpoint: "https://mcp.example/mcp",
          transport: "streamable_http",
          toolNames: ["risk_query"],
        }],
      },
    });
    await runtime.prepare();
    const evidence = await runtime.execute({
      runId: "local-run",
      side: "right",
      evalCase: {
        caseId: "HTTP-1",
        name: "HTTP case",
        taskMode: "single_turn",
        prompt: "Review risk.",
        evaluationGoal: "Compare.",
        requiredTools: ["risk_query"],
        rubric: [{
          criterionId: "risk",
          label: "Risk",
          description: "Risk review",
          dimension: "professional_fit",
          weight: 1,
          required: true,
          allOf: [],
          anyOf: [],
          noneOf: [],
        }],
      },
      model: { providerId: "test", modelId: "glm-5.2", parameters: {} },
      variant: { mode: "skill_version", skillId: "risk-review", version: "1.0.0" },
    });

    expect(evidence.runId).toBe("local-run");
    expect(evidence.toolCalls).toEqual([{ name: "risk_query", status: "completed" }]);
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe("https://agent.example/api/health");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      environment: {
        environmentId: "openjiuwen-eval",
        harnessToolNames:['glob'],
        runtimeToolConfig: {tools:{risk_query:{contextBindings:{'X-Business-User':'context.user'}}}},
        requiredToolNames: ["risk_query"],
        mcpServers: [{ serverId: "risk-mcp", toolNames: ["risk_query"] }],
      },
    });
  });
});
