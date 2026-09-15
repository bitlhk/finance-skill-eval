import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { createEvaluationService } from "../dist/service/server.js";

const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const artifactDirectory = path.resolve(".tmp", `live-http-e2e-${stamp}`);
await mkdir(artifactDirectory, { recursive: true });

const skillZip = Buffer.from(zipSync({
  "SKILL.md": strToU8(`---
name: live-http-finance-proof
version: 1.0.0
displayName: Live HTTP Finance Proof
description: 用于验证真实模型 Eval 与 Judge HTTP 链路。
---

# Live HTTP Finance Proof

回答金融计算题时必须：

1. 列出公式和代入值；
2. 给出计算结果；
3. 说明关键假设；
4. 明确这只是演示计算，不构成投资建议。
`),
}));
await writeFile(path.join(artifactDirectory, "uploaded-skill.zip"), skillZip);

const app = await createEvaluationService({
  rootDirectory: path.resolve("."),
  dataDirectory: path.join(artifactDirectory, "service-data"),
  publicDirectory: path.resolve("web-dist"),
  host: "127.0.0.1",
  port: 0,
  accessToken: null,
  publicDemo: false,
  maxConcurrentRuns: 1,
});

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { body = text; }
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${route} failed (${response.status}): ${text}`);
  }
  return body;
}

let baseUrl;
try {
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const catalog = await request(baseUrl, "/api/catalog");
  if (!catalog.modelRoles.directExecution.configured) throw new Error("Execution model is not configured");
  if (!catalog.modelRoles.judge.configured) throw new Error("Judge model is not configured");

  const asset = await request(baseUrl, "/api/skills/upload", {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body: skillZip,
  });
  const prepared = await request(baseUrl, `/api/skills/${asset.assetId}/prepare/manual`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      summary: "真实 HTTP Eval 与模型 Judge 端到端验证题集。",
      cases: [{
        caseId: "LIVE-HTTP-E2E-001",
        name: "单利计算与边界说明",
        taskMode: "single_turn",
        prompt: "本金 10000 元，年化收益率 3%，不考虑复利，一年后的本息合计是多少？请简要说明。",
        evaluationGoal: "绝对核验迁移候选的计算准确性、假设说明和表达完整性。",
        requiredTools: [],
        rubric: [{
          criterionId: "complete-finance-answer",
          label: "计算与说明完整",
          description: "答案应包含正确计算、假设和必要边界说明。",
          dimension: "business_completeness",
          weight: 1,
          required: true,
          allOf: [],
          anyOf: [],
          noneOf: [],
          improvementHint: "补充公式、假设及非投资建议说明。",
        }],
      }],
      holdoutCases: [],
    }),
  });
  const created = await request(baseUrl, "/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      preparationId: prepared.preparationId,
      runtime: { type: "direct_model" },
      judgeMode: "model",
      evaluationMode: "candidate_assessment",
      skillAssetId: asset.assetId,
      selectedCaseIds: ["LIVE-HTTP-E2E-001"],
      timeoutMs: 310000,
    }),
  });

  let job = created;
  const deadline = Date.now() + 360000;
  while (!['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${created.jobId}`);
    await new Promise(resolve => setTimeout(resolve, 750));
    job = await request(baseUrl, `/api/runs/${created.jobId}`);
  }
  await writeFile(path.join(artifactDirectory, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
  if (job.status !== "completed") throw new Error(JSON.stringify(job.error));
  if (job.configuration.runtime.type !== "direct_model") throw new Error("Runtime was not direct_model");
  if (job.configuration.judgeMode !== "model") throw new Error("Judge was not model mode");
  if (!job.report?.runtimeAdapterId?.startsWith("direct-model")) throw new Error("Unexpected runtime adapter");
  if (!job.report?.judgeId?.startsWith("model-candidate:service-judge-openai-compatible")) throw new Error("Unexpected candidate judge adapter");
  const testCase = job.report.cases?.[0];
  if (!testCase || testCase.left.status !== "completed" || testCase.right.status !== "completed") {
    throw new Error("Both eval sides must complete");
  }
  if (!testCase.left.usage?.totalTokens || !testCase.right.usage?.totalTokens) {
    throw new Error("Execution model token usage is missing");
  }
  if (!testCase.judge) throw new Error(`Model Judge did not produce a verdict: ${testCase.judgeError}`);

  const proof = {
    verifiedAt: new Date().toISOString(),
    transport: "real Fastify HTTP listener + fetch",
    jobId: job.jobId,
    status: job.status,
    configuration: {
      runtime: job.configuration.runtime,
      judgeMode: job.configuration.judgeMode,
      evaluationMode: job.configuration.evaluationMode,
    },
    models: {
      configuredExecution: catalog.modelRoles.directExecution.model.modelId,
      configuredJudge: catalog.modelRoles.judge.model.modelId,
      returnedExecution: [testCase.left.modelId, testCase.right.modelId],
    },
    execution: [testCase.left, testCase.right].map(item => ({
      side: item.side,
      status: item.status,
      modelId: item.modelId,
      elapsedMs: item.elapsedMs,
      usage: item.usage,
      traceFingerprint: item.traceFingerprint,
    })),
    judge: {
      judgeId: job.report.judgeId,
      winner: testCase.judge.winner,
      confidence: testCase.judge.confidence,
      reviewerLabel: testCase.judge.reviewerLabel,
    },
    reportFingerprint: job.report.reportFingerprint,
    artifacts: artifactDirectory,
  };
  if (proof.judge.winner !== "tie") throw new Error("Candidate assessment must not declare a left/right winner");
  await writeFile(path.join(artifactDirectory, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof, null, 2));
} finally {
  await app.close();
}
