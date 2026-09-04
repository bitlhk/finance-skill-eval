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
  });
});
