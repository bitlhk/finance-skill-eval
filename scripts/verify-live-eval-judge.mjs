import { createHash } from "node:crypto";
import { configuredModelRole } from "../dist/service/config.js";
import { DirectModelRuntimeAdapter } from "../dist/direct-model-runtime.js";
import { ModelPairwiseJudge } from "../dist/judge.js";

const digest = value => createHash("sha256").update(value).digest("hex");

function recordingAdapter(role, calls) {
  if (!role.configured || !role.adapter) {
    throw new Error(`Model role is not configured: ${role.model.providerId}`);
  }
  return {
    adapterId: role.adapter.adapterId,
    async complete(request) {
      const startedAt = Date.now();
      const response = await role.adapter.complete(request);
      calls.push({
        requestId: request.requestId,
        configuredModelId: request.model.modelId,
        returnedModelId: response.modelId,
        elapsedMs: Date.now() - startedAt,
        usage: response.usage ?? null,
        contentSha256: digest(response.content),
      });
      return response;
    },
  };
}

const executionRole = configuredModelRole("EXECUTION");
const judgeRole = configuredModelRole("JUDGE");
const executionCalls = [];
const judgeCalls = [];

const runtime = new DirectModelRuntimeAdapter({
  adapterId: "live-direct-model-verification-v1",
  modelAdapter: recordingAdapter(executionRole, executionCalls),
  async resolveSkill(variant) {
    if (variant.mode !== "skill_version") return null;
    return {
      skillId: variant.skillId,
      version: variant.version,
      artifactSha256: digest("live-verification-skill-v1"),
      instructions: "回答金融计算题时，明确列出公式、代入值、结果，并说明这只是演示计算而非投资建议。",
    };
  },
});

const evalCase = {
  caseId: "live-model-proof-001",
  title: "真实模型链路验证",
  prompt: "本金 10000 元，年化收益率 3%，不考虑复利，一年后的本息合计是多少？简要说明。",
  evaluationGoal: "答案应给出正确计算、必要说明和边界声明。",
  requiredTools: [],
  rubric: [],
  tags: ["live-verification"],
};
const common = {
  runId: `live-proof-${Date.now()}`,
  evalCase,
  model: executionRole.model,
};
const left = await runtime.execute({
  ...common,
  side: "left",
  variant: { mode: "without_target_skill", skillId: "live-verification-skill" },
});
const right = await runtime.execute({
  ...common,
  side: "right",
  variant: { mode: "skill_version", skillId: "live-verification-skill", version: "1.0.0" },
});

const profile = {
  profileId: "live-model-proof-v1",
  reviewerLabel: "Live model judge",
  domainInstructions: "你是金融内容质量评审。只根据给定题面和答案进行比较。",
  dimensions: [
    { id: "professional_fit", label: "专业适配" },
    { id: "business_completeness", label: "业务完整" },
    { id: "clarity", label: "清晰度" },
    { id: "actionability", label: "可执行性" },
  ],
};
const judge = new ModelPairwiseJudge(
  recordingAdapter(judgeRole, judgeCalls),
  judgeRole.model,
);
const verdict = await judge.compare({ evalCase, left, right, profile });

console.log(JSON.stringify({
  verifiedAt: new Date().toISOString(),
  execution: {
    adapterId: executionRole.adapter.adapterId,
    configuredModel: executionRole.model,
    runtimeAdapterId: runtime.adapterId,
    calls: executionCalls,
    evidence: [left, right].map(item => ({
      side: item.side,
      status: item.status,
      modelId: item.modelId,
      usage: item.usage,
      elapsedMs: item.elapsedMs,
      traceFingerprint: item.traceFingerprint,
    })),
  },
  judge: {
    adapterId: judgeRole.adapter.adapterId,
    configuredModel: judgeRole.model,
    judgeId: judge.judgeId,
    calls: judgeCalls,
    verdict: {
      winner: verdict.winner,
      confidence: verdict.confidence,
      reviewerLabel: verdict.reviewerLabel,
      fingerprint: digest(JSON.stringify(verdict)),
    },
  },
}, null, 2));
