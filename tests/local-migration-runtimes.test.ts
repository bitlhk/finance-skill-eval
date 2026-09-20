import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LocalMigrationRuntimeCatalog } from "../src/service/local-migration-runtimes.js";
import { createEvaluationService } from "../src/service/server.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "local-migration-runtime-"));
  directories.push(directory);
  const configFile = path.join(directory, "runtime.json");
  await writeFile(configFile, JSON.stringify({
    defaultModelId: "execution-model",
    models: {
      "execution-model": {
        providerId: "service-execution",
        providerLabel: "企业模型网关",
        baseUrl: "https://model.internal/v1",
        apiKey: "must-not-reach-browser",
        upstreamModelId: "deepseek-v4-flash",
        enabled: true,
      },
      disabled: {
        baseUrl: "https://disabled.internal/v1",
        apiKey: "disabled-secret",
        upstreamModelId: "disabled",
        enabled: false,
      },
    },
    mcp: { "http://127.0.0.1:9000/mcp": { headers: { authorization: "secret" } } },
  }));
  vi.stubEnv("FINANCE_RUNTIME_CONFIG", configFile);
  return { directory, configFile };
}

it("projects models from the local Runtime without exposing model or MCP credentials", async () => {
  const { directory } = await fixture();
  const catalog = new LocalMigrationRuntimeCatalog(directory);
  const runtimes = await catalog.publicList();
  expect(runtimes).toEqual([expect.objectContaining({
    runtimeId: "local-openjiuwen",
    defaultModelId: "execution-model",
    models: [expect.objectContaining({ modelId: "execution-model", providerId: "service-execution", upstreamModelId: "deepseek-v4-flash" })],
  })]);
  expect(JSON.stringify(runtimes)).not.toMatch(/must-not-reach-browser|model\.internal|authorization|9000/);
  await expect(catalog.resolveModel("local-openjiuwen", { providerId: "attacker", modelId: "execution-model" })).rejects.toThrow(/不属于/);
});

it("keeps legacy test environments separate from the migration Runtime list", async () => {
  const { directory } = await fixture();
  const dataDirectory = path.join(directory, "data");
  const app = await createEvaluationService({ rootDirectory: path.resolve("."), dataDirectory, accessToken: "private" });
  try {
    await app.inject({
      method: "POST",
      url: "/api/environments",
      headers: { authorization: "Bearer private" },
      payload: { name: "不应出现在迁移里的环境", type: "runtime_http", runtimeType: "openjiuwen", endpoint: "http://127.0.0.1:59999/execute" },
    });
    const response = await app.inject({ url: "/api/catalog", headers: { authorization: "Bearer private" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().environments).toEqual([expect.objectContaining({ name: "不应出现在迁移里的环境" })]);
    expect(response.json().migrationRuntimes).toEqual([expect.objectContaining({ runtimeId: "local-openjiuwen" })]);
    expect(JSON.stringify(response.json().migrationRuntimes)).not.toContain("不应出现在迁移里的环境");
  } finally {
    await app.close();
  }
});
