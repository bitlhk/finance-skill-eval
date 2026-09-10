import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredModelRole } from "../src/service/config.js";

afterEach(() => vi.unstubAllEnvs());

describe("Codex Judge configuration", () => {
  it("keeps the Codex default independent of the shared execution model", () => {
    vi.stubEnv("FINANCE_EVAL_JUDGE_PROVIDER", "codex_cli");
    vi.stubEnv("FINANCE_EVAL_JUDGE_MODEL", undefined);
    vi.stubEnv("FINANCE_EVAL_MODEL", "glm-5.2");
    vi.stubEnv("FINANCE_EVAL_EXECUTION_MODEL", "glm-5.2");
    vi.stubEnv("FINANCE_EVAL_ANALYZER_MODEL", "glm-5.2");

    const judge = configuredModelRole("JUDGE");
    expect(judge.configured).toBe(true);
    expect(judge.model.modelId).toBe("gpt-6-astra");
    expect(judge.adapter?.adapterId).toBe("codex-cli-model-v1");
    expect(configuredModelRole("EXECUTION").model.modelId).toBe("glm-5.2");
    expect(configuredModelRole("ANALYZER").model.modelId).toBe("glm-5.2");
  });

  it("respects an explicitly configured Codex Judge model", () => {
    vi.stubEnv("FINANCE_EVAL_JUDGE_PROVIDER", "codex_cli");
    vi.stubEnv("FINANCE_EVAL_JUDGE_MODEL", " pinned-judge-model ");

    expect(configuredModelRole("JUDGE").model.modelId).toBe("pinned-judge-model");
  });
});
