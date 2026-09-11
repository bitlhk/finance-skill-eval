import { describe, expect, it } from "vitest";
import { CodexCliModelAdapter, parseCodexJsonOutput } from "../src/codex-cli-model.js";

describe("Codex CLI model output", () => {
  it("does not spawn a CLI process for an already cancelled request", async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled before spawn"));
    const adapter = new CodexCliModelAdapter({ executable: "/must-not-run" });
    await expect(adapter.complete({ requestId: "cancelled", model: { providerId: "test", modelId: "test", parameters: {} }, messages: [], signal: controller.signal })).rejects.toThrow("cancelled before spawn");
  });
  it("extracts the final agent message and usage from Codex JSONL", () => {
    const parsed = parseCodexJsonOutput([
      '{"type":"thread.started","thread_id":"thread-1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"winner\\":\\"A\\"}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":30}}',
    ].join("\n"));

    expect(parsed).toEqual({
      content: '{"winner":"A"}',
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
  });
});
