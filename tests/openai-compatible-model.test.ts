import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleModelAdapter } from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAiCompatibleModelAdapter", () => {
  it("maps an OpenAI-compatible JSON completion without exposing credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "judge-model",
      choices: [{ message: { content: "{\"winner\":\"A\"}" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OpenAiCompatibleModelAdapter({
      apiKey: "not-recorded",
      baseUrl: "https://models.example/v1/",
    });

    const response = await adapter.complete({
      requestId: "judge-001",
      model: { providerId: "test", modelId: "judge-model", parameters: {} },
      messages: [{ role: "user", content: "compare" }],
      responseFormat: "json",
    });

    expect(response.content).toBe("{\"winner\":\"A\"}");
    expect(response.usage?.totalTokens).toBe(15);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://models.example/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
