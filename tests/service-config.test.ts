import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configuredModelRole, loadServiceConfig, modelTimeoutMs } from "../src/service/config.js";

afterEach(() => vi.unstubAllEnvs());

describe("per-completion deadline", () => {
  it("gives the question writer room to reason", () => {
    // Measured: the same request to `deepseek-v4-flash` took 36 s, 147 s and 185 s on three
    // consecutive runs, tracking how long the model chose to reason (~20k tokens on the slow ones).
    // A 180 s ceiling sits inside that spread, so the stage fails intermittently and the failure
    // reads as a timeout, which sounds like a hang.
    expect(modelTimeoutMs("ANALYZER")).toBeGreaterThan(185_000);
  });

  it("lets an operator pin one, because the model behind a role can change", () => {
    vi.stubEnv("FINANCE_EVAL_ANALYZER_TIMEOUT_MS", "90000");
    expect(modelTimeoutMs("ANALYZER")).toBe(90_000);
    vi.stubEnv("FINANCE_EVAL_ANALYZER_TIMEOUT_MS", "not a number");
    expect(modelTimeoutMs("ANALYZER")).toBe(600_000);
    vi.stubEnv("FINANCE_EVAL_ANALYZER_TIMEOUT_MS", "0");
    expect(modelTimeoutMs("ANALYZER")).toBe(600_000);
  });

  it("reaches the adapter, not just the helper", () => {
    vi.stubEnv("FINANCE_EVAL_ANALYZER_BASE_URL", "https://example.invalid/v1");
    vi.stubEnv("FINANCE_EVAL_ANALYZER_API_KEY", "k");
    vi.stubEnv("FINANCE_EVAL_ANALYZER_TIMEOUT_MS", "45000");
    expect(configuredModelRole("ANALYZER").adapter?.adapterId).toBe("service-analyzer-openai-compatible-v1");
    expect(configuredModelRole("ANALYZER").configured).toBe(true);
  });
});

describe("Builder Launcher admission",()=>{
  it("loads operator-owned container trials with networking disabled by default",()=>{
    vi.stubEnv("FINANCE_EVAL_MIGRATION_SANDBOX_JSON",JSON.stringify({image:'sha256:'+'a'.repeat(64)}));
    expect(loadServiceConfig().migrationSandbox).toMatchObject({network:'none',maxConcurrent:1});
    vi.stubEnv("FINANCE_EVAL_MIGRATION_SANDBOX_JSON",JSON.stringify({image:'sha256:'+'a'.repeat(64),network:'host'}));
    expect(()=>loadServiceConfig()).toThrow();
  });
  it("normalizes operator-managed targets and rejects insecure remote prefixes",()=>{
    vi.stubEnv("FINANCE_EVAL_LAUNCHER_TRUST_JSON",JSON.stringify([{reference:"builder-local",label:"Local Builder",baseUrlPrefix:"http://127.0.0.1:9000/launchers",credentialEnv:null}]));
    expect(loadServiceConfig().launcherTrust).toEqual([{reference:"builder-local",label:"Local Builder",baseUrlPrefix:"http://127.0.0.1:9000/launchers/",credentialEnv:null}]);
    vi.stubEnv("FINANCE_EVAL_LAUNCHER_TRUST_JSON",JSON.stringify([{reference:"builder-remote",label:"Remote Builder",baseUrlPrefix:"http://runtime.example.com/",credentialEnv:"RUNTIME_TOKEN"}]));
    expect(()=>loadServiceConfig()).toThrow(/requires HTTPS/u);
  });
});

describe("Codex Judge configuration", () => {
  it("keeps the Codex default independent of the shared execution model", () => {
    vi.stubEnv("FINANCE_EVAL_CODEX_BIN", process.execPath);
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

  it("does not advertise an unavailable command as configured", () => {
    vi.stubEnv("FINANCE_EVAL_JUDGE_PROVIDER", "codex_cli");
    vi.stubEnv("FINANCE_EVAL_CODEX_BIN", "/missing/finance-judge-codex");
    expect(configuredModelRole("JUDGE").configured).toBe(false);
    expect(configuredModelRole("JUDGE").adapter).toBeNull();
  });

  it("uses an explicit executable even when the service PATH is empty", () => {
    vi.stubEnv("FINANCE_EVAL_JUDGE_PROVIDER", "codex_cli");
    vi.stubEnv("FINANCE_EVAL_CODEX_BIN", process.execPath);
    vi.stubEnv("PATH", "");
    expect(configuredModelRole("JUDGE").configured).toBe(true);
  });

  it("checks service PATH and rejects directories or non-executable files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "judge-readiness-"));
    try {
      vi.stubEnv("FINANCE_EVAL_JUDGE_PROVIDER", "codex_cli");
      vi.stubEnv("FINANCE_EVAL_CODEX_BIN", undefined);
      vi.stubEnv("PATH", root);
      expect(configuredModelRole("JUDGE").configured).toBe(false);
      writeFileSync(path.join(root, "codex"), "fixture-not-executed", {mode: 0o600});
      expect(configuredModelRole("JUDGE").configured).toBe(false);
      chmodSync(path.join(root, "codex"), 0o700);
      expect(configuredModelRole("JUDGE").configured).toBe(true);
      vi.stubEnv("FINANCE_EVAL_CODEX_BIN", root);
      expect(configuredModelRole("JUDGE").configured).toBe(false);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
});
