import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultOnlineExecutionModel, executionModelCatalog, resolvePublicExecutionModels } from "../src/service/execution-models.js";
import { configuredModelRole } from "../src/service/config.js";
import { createEvaluationService } from "../src/service/server.js";
import { EnvironmentStore } from "../src/service/environment-store.js";
import { EvaluationRunManager } from "../src/service/run-manager.js";

const directories: string[] = [];
const model = (id: string, availability = "ready") => ({ providerId: "service-execution", modelId: id, label: id, parameters: {}, availability });
async function fixture(models = [model("glm-5.2"), model("glm-5.3"), model("pending", "unverified"), model("down", "unavailable")], defaultModelId = "glm-5.2") {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-models-"));
  directories.push(directory);
  const file = path.join(directory, "models.json");
  await writeFile(file, JSON.stringify({ schemaVersion: "finance.skill-eval.execution-models.v1", defaultModelId, models }));
  vi.stubEnv("FINANCE_EVAL_EXECUTION_CATALOG", file);
  return directory;
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("execution model catalog", () => {
  it("uses the catalog default on both sides without changing direct execution or the Judge", async () => {
    await fixture([model("glm-5.2"), model("glm-5.3-flash")], "glm-5.3-flash");
    vi.stubEnv("FINANCE_EVAL_EXECUTION_MODEL", "glm-5.2");
    vi.stubEnv("FINANCE_EVAL_JUDGE_PROVIDER", "codex_cli");
    vi.stubEnv("FINANCE_EVAL_JUDGE_MODEL", "gpt-6-astra");
    expect((await defaultOnlineExecutionModel()).modelId).toBe("glm-5.3-flash");
    const defaults = await resolvePublicExecutionModels({});
    expect(defaults.leftExecutionModel.modelId).toBe("glm-5.3-flash");
    expect(defaults.rightExecutionModel.modelId).toBe("glm-5.3-flash");
    expect(configuredModelRole("EXECUTION").model.modelId).toBe("glm-5.2");
    expect(configuredModelRole("JUDGE").model.modelId).toBe("gpt-6-astra");
    expect((await resolvePublicExecutionModels({ rightExecutionModel: model("glm-5.2") })).rightExecutionModel.modelId).toBe("glm-5.2");
  });
  it("preserves separate A/B choices and drops client-controlled credentials and parameters", async () => {
    await fixture();
    const result = await resolvePublicExecutionModels({
      leftExecutionModel: { ...model("glm-5.2"), credentialRef: "injected", parameters: { max_tokens: 999999 } },
      rightExecutionModel: model("glm-5.3"),
    });
    expect(result.leftExecutionModel.modelId).toBe("glm-5.2");
    expect(result.rightExecutionModel.modelId).toBe("glm-5.3");
    expect(result.leftExecutionModel.parameters).toEqual({});
    expect(result.leftExecutionModel.credentialRef).toBeUndefined();
  });
  it("reloads a changed default without overriding an explicit model choice", async () => {
    const models = [model("glm-5.2"), model("glm-5.3-flash")];
    const directory = await fixture(models, "glm-5.3-flash");
    expect((await defaultOnlineExecutionModel()).modelId).toBe("glm-5.3-flash");
    await writeFile(path.join(directory, "models.json"), JSON.stringify({
      schemaVersion: "finance.skill-eval.execution-models.v1", defaultModelId: "glm-5.2", models,
    }));
    expect((await defaultOnlineExecutionModel()).modelId).toBe("glm-5.2");
    const defaults = await resolvePublicExecutionModels({});
    expect(defaults.leftExecutionModel.modelId).toBe("glm-5.2");
    expect(defaults.rightExecutionModel.modelId).toBe("glm-5.2");
    expect((await resolvePublicExecutionModels({ rightExecutionModel: model("glm-5.3-flash") })).rightExecutionModel.modelId).toBe("glm-5.3-flash");
  });
  it("rejects unknown, pending, unavailable and provider-spoofed choices", async () => {
    await fixture();
    for (const selection of [model("unknown"), model("pending"), model("down"), { ...model("glm-5.2"), providerId: "attacker" }]) {
      await expect(resolvePublicExecutionModels({ rightExecutionModel: selection })).rejects.toMatchObject({ statusCode: 400 });
    }
  });
  it("rejects duplicate identities and does not silently fall back on malformed configuration", async () => {
    await fixture([model("glm-5.2"), model("glm-5.2")]);
    await expect(executionModelCatalog()).rejects.toThrow(/duplicate/);
  });
  it("supports the existing single-model setup without an imported catalog", async () => {
    vi.stubEnv("FINANCE_EVAL_EXECUTION_CATALOG", "");
    vi.stubEnv("FINANCE_EVAL_EXECUTION_MODEL", "original");
    expect((await resolvePublicExecutionModels({})).rightExecutionModel.modelId).toBe("original");
  });
  it("public API passes selected models through while keeping the Judge server-controlled", async () => {
    const directory = await fixture();
    vi.stubEnv("FINANCE_EVAL_JUDGE_PROVIDER", "codex_cli");
    vi.stubEnv("FINANCE_EVAL_JUDGE_MODEL", "gpt-6-astra");
    const environments = new EnvironmentStore(directory); await environments.initialize();
    const environment = await environments.create({ name: "Runtime", type: "runtime_http", endpoint: "http://localhost:56362/execute" });
    const create = vi.spyOn(EvaluationRunManager.prototype, "create").mockResolvedValue({ jobId: "run-model-test" } as never);
    const app = await createEvaluationService({ rootDirectory: path.resolve("."), dataDirectory: directory, publicDemo: true, accessToken: "test-only" });
    try {
      const headers = { authorization: "Bearer test-only", "x-demo-user": "studio_test" };
      const catalog = (await app.inject({ url: "/api/catalog", headers })).json();
      expect(catalog.models).toHaveLength(4);
      const pack = catalog.evalPacks.find((p: { packId: string }) => p.packId.endsWith("-online-v1"));
      const payload = { packId: pack.packId, runtime: { type: "runtime_http", environmentId: environment.environmentId },
        leftExecutionModel: { providerId: "service-execution", modelId: "glm-5.2", parameters: {} },
        rightExecutionModel: { providerId: "service-execution", modelId: "glm-5.3", parameters: {} },
        judgeModel: { providerId: "untrusted", modelId: "judge-injected", parameters: {} } };
      const response = await app.inject({ method: "POST", url: "/api/runs", headers, payload });
      expect(response.statusCode).toBe(202);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        leftExecutionModel: expect.objectContaining({ modelId: "glm-5.2" }),
        rightExecutionModel: expect.objectContaining({ modelId: "glm-5.3" }),
        judgeModel: expect.objectContaining({ modelId: "gpt-6-astra" }),
      }));
      const rejected = await app.inject({ method: "POST", url: "/api/runs", headers,
        payload: { ...payload, rightExecutionModel: { ...payload.rightExecutionModel, modelId: "missing" } } });
      expect(rejected.statusCode).toBe(400);
      expect(create).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
});
