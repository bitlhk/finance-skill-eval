import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { createEvaluationService } from "../src/service/server.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("standalone evaluation service", () => {
  it('keeps public demo administration and model consumption behind authenticated curated routes',async()=>{
    const dataDirectory=await mkdtemp(path.join(tmpdir(),'finance-eval-public-')); directories.push(dataDirectory);
    await expect(createEvaluationService({publicDemo:true,accessToken:null,dataDirectory})).rejects.toThrow(/ingress/);
    const app=await createEvaluationService({publicDemo:true,accessToken:'test-token',dataDirectory,rootDirectory:path.resolve('.'),publicDirectory:path.resolve('web-dist')});
    try{
      expect((await app.inject({url:'/api/catalog'})).statusCode).toBe(401);
      const headers={authorization:'Bearer test-token','x-demo-user':'studio_1'};
      expect((await app.inject({url:'/api/catalog',headers})).json().publicDemo).toBe(true);
      for(const url of ['/api/environments','/api/skills/upload','/api/runs/run-one/optimize','/api/runs/run-one/retry']){
        expect((await app.inject({method:'POST',url,headers,payload:{}})).statusCode).toBe(403);
      }
      expect((await app.inject({method:'POST',url:'/api/runs',headers:{authorization:'Bearer test-token'},payload:{}})).statusCode).toBe(401);
      expect((await app.inject({method:'POST',url:'/api/runs',headers:{...headers,origin:'https://other.example'},payload:{}})).statusCode).toBe(403);
      expect((await app.inject({method:'POST',url:'/api/runs',headers,payload:{packId:'wealth-manager-online-v1',runtime:{type:'replay'}}})).statusCode).toBe(400);
    }finally{await app.close();}
  });
  it("lists preset packs, accepts a Skill ZIP and completes a persisted replay run", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "finance-eval-service-"));
    directories.push(dataDirectory);
    const app = await createEvaluationService({
      rootDirectory: path.resolve("."),
      dataDirectory,
      publicDirectory: path.resolve("web-dist"),
      maxConcurrentRuns: 1,
    });
    try {
      const catalog = await app.inject({ method: "GET", url: "/api/catalog" });
      expect(catalog.statusCode).toBe(200);
      expect(catalog.json().evalPacks).toEqual(expect.arrayContaining([
        expect.objectContaining({ targetSkillId: "wealth-manager-assistant", replayReady: true }),
      ]));
      expect(catalog.json().featuredSkills).toEqual(expect.arrayContaining([
        expect.objectContaining({
          skillId: "wealth-manager-assistant",
          displayName: "财富经理助手",
          evaluationStatus: "environment_required",
        }),
        expect.objectContaining({
          skillId: "auto-insurance-advisor",
          evaluationStatus: "environment_required",
        }),
      ]));
      expect(catalog.json().models).toEqual(expect.arrayContaining([
        expect.objectContaining({ modelId: "glm-5.2" }),
      ]));

      const mcpEnvironment = await app.inject({
        method: "POST",
        url: "/api/environments",
        payload: {
          name: "Wealth MCP",
          type: "mcp_streamable_http",
          endpoint: "https://mcp.example/mcp",
          mcpEnvironmentIds: [],
        },
      });
      expect(mcpEnvironment.statusCode).toBe(200);
      const runtimeEnvironment = await app.inject({
        method: "POST",
        url: "/api/environments",
        payload: {
          name: "OpenJiuwen Eval Runtime",
          type: "runtime_http",
          runtimeType: "openjiuwen",
          endpoint: "https://runtime.example/eval/execute",
          mcpEnvironmentIds: [mcpEnvironment.json().environmentId],
        },
      });
      expect(runtimeEnvironment.statusCode).toBe(200);
      expect(runtimeEnvironment.json()).toMatchObject({
        runtimeType: "openjiuwen",
        mcpEnvironmentIds: [mcpEnvironment.json().environmentId],
      });

      const skillSource = Buffer.from(`---
name: transfer-risk-review
version: 0.1.0
displayName: 转账风险审核
description: 根据已核验风险证据形成审核建议。
---

# 转账风险审核

区分事实、风险信号与待核实事项，并给出可执行的审核建议。
`, "utf8");
      const uploaded = await app.inject({
        method: "POST",
        url: "/api/skills/upload",
        headers: { "content-type": "application/zip" },
        payload: Buffer.from(zipSync({ "SKILL.md": skillSource })),
      });
      expect(uploaded.statusCode).toBe(200);
      expect(uploaded.json()).toMatchObject({ skillId: "transfer-risk-review", version: "0.1.0" });

      const created = await app.inject({
        method: "POST",
        url: "/api/runs",
        payload: {
          packId: "wealth-manager-assistant-professional-value-v1",
          runtime: { type: "replay" },
          judgeMode: "deterministic",
          selectedCaseIds: ["WM-SKILL-EVAL-001", "WM-SKILL-EVAL-006"],
          timeoutMs: 310_000,
        },
      });
      expect(created.statusCode).toBe(202);
      const jobId = created.json().jobId as string;
      let job: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 80; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const response = await app.inject({ method: "GET", url: `/api/runs/${jobId}` });
        job = response.json();
        if (["completed", "failed"].includes(String(job.status))) break;
      }
      expect(job.status).toBe("completed");
      expect(job.report).toMatchObject({
        summary: { leftWins: 0, rightWins: 2, ties: 0 },
      });

      const exported = await app.inject({
        method: "GET",
        url: `/api/runs/${jobId}/export?format=html`,
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.body).toContain("右侧更优");
    } finally {
      await app.close();
    }
  }, 30_000);
});
