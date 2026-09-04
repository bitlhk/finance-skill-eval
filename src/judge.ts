import { z } from "zod";
import type { ModelAdapter } from "./adapters.js";
import {
  fingerprint,
  judgeResultSchema,
  type EvalCase,
  type JudgeProfile,
  type JudgeResult,
  type ModelRef,
  type RubricCriterion,
  type RuntimeExecutionEvidence,
} from "./contracts.js";
import { parseFirstJsonObject } from "./json-response.js";

export interface PairwiseJudge {
  readonly judgeId: string;
  compare(input: {
    evalCase: EvalCase;
    left: RuntimeExecutionEvidence;
    right: RuntimeExecutionEvidence;
    profile: JudgeProfile;
  }): Promise<JudgeResult>;
}

type CriterionCheck = {
  criterion: RubricCriterion;
  passed: boolean;
  missing: string[];
  prohibited: string[];
};

function matches(pattern: string, output: string): boolean {
  return new RegExp(pattern, "iu").test(output);
}

function checkCriterion(
  criterion: RubricCriterion,
  output: string,
): CriterionCheck {
  const missingAll = criterion.allOf.filter(pattern => !matches(pattern, output));
  const hasAny = criterion.anyOf.length === 0
    || criterion.anyOf.some(pattern => matches(pattern, output));
  const prohibited = criterion.noneOf.filter(pattern => matches(pattern, output));
  return {
    criterion,
    passed: missingAll.length === 0 && hasAny && prohibited.length === 0,
    missing: [
      ...missingAll,
      ...(hasAny ? [] : [`任一：${criterion.anyOf.join(" / ")}`]),
    ],
    prohibited,
  };
}

function dimensionScore(
  dimension: RubricCriterion["dimension"],
  checks: CriterionCheck[],
): number {
  const selected = checks.filter(check => check.criterion.dimension === dimension);
  const total = selected.reduce((sum, check) => sum + check.criterion.weight, 0);
  if (total === 0) return 0;
  const passed = selected.reduce(
    (sum, check) => sum + (check.passed ? check.criterion.weight : 0),
    0,
  );
  return Math.round((passed / total) * 40) / 10;
}

function reasonForDimension(
  dimension: RubricCriterion["dimension"],
  left: CriterionCheck[],
  right: CriterionCheck[],
): string {
  const passedLabels = (checks: CriterionCheck[]) => checks
    .filter(check => check.criterion.dimension === dimension && check.passed)
    .map(check => check.criterion.label);
  const leftPassed = passedLabels(left);
  const rightPassed = passedLabels(right);
  return `左侧满足：${leftPassed.join("、") || "无"}；右侧满足：${rightPassed.join("、") || "无"}。`;
}

export class DeterministicRubricJudge implements PairwiseJudge {
  readonly judgeId = "deterministic-rubric-v1";

  async compare(input: {
    evalCase: EvalCase;
    left: RuntimeExecutionEvidence;
    right: RuntimeExecutionEvidence;
    profile: JudgeProfile;
  }): Promise<JudgeResult> {
    const leftChecks = input.evalCase.rubric.map(criterion => (
      checkCriterion(criterion, input.left.output)
    ));
    const rightChecks = input.evalCase.rubric.map(criterion => (
      checkCriterion(criterion, input.right.output)
    ));
    const dimensions = input.profile.dimensions.map(dimension => ({
      id: dimension.id,
      label: dimension.label,
      leftScore: dimensionScore(dimension.id, leftChecks),
      rightScore: dimensionScore(dimension.id, rightChecks),
      reason: reasonForDimension(dimension.id, leftChecks, rightChecks),
    }));
    const leftTotal = dimensions.reduce((sum, dimension) => sum + dimension.leftScore, 0);
    const rightTotal = dimensions.reduce((sum, dimension) => sum + dimension.rightScore, 0);
    const winner = Math.abs(leftTotal - rightTotal) < 0.1
      ? "tie" as const
      : leftTotal > rightTotal ? "left" as const : "right" as const;
    const difference = Math.abs(leftTotal - rightTotal);
    return {
      winner,
      confidence: difference >= 4 ? "high" : difference >= 2 ? "medium" : "low",
      summary: winner === "tie"
        ? "两侧均覆盖了当前确定性规则要求，需由业务 Judge 比较表达与判断质量。"
        : `${winner === "left" ? "左侧" : "右侧"}覆盖了更多金融专业闭环要素。`,
      dimensions,
      reviewerLabel: input.profile.reviewerLabel,
    };
  }
}

const anonymousJudgeResponseSchema = z.strictObject({
  winner: z.enum(["A", "B", "TIE"]),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string().min(1),
  dimensions: z.array(z.strictObject({
    id: z.enum([
      "professional_fit",
      "business_completeness",
      "clarity",
      "actionability",
    ]),
    label: z.string().min(1),
    aScore: z.number().min(0).max(4),
    bScore: z.number().min(0).max(4),
    reason: z.string().min(1),
  })).length(4),
});

export function remapAnonymousSideLabels(text: string, swapped: boolean): string {
  if (!swapped) return text;
  return text
    .replace(/(?<![A-Za-z0-9])A(?![A-Za-z0-9])/g, "__FINANCE_EVAL_SIDE_A__")
    .replace(/(?<![A-Za-z0-9])B(?![A-Za-z0-9])/g, "A")
    .replace(/__FINANCE_EVAL_SIDE_A__/g, "B");
}

export class ModelPairwiseJudge implements PairwiseJudge {
  readonly judgeId: string;

  constructor(
    private readonly adapter: ModelAdapter,
    private readonly model: ModelRef,
  ) {
    this.judgeId = `model-pairwise:${adapter.adapterId}:${model.providerId}:${model.modelId}`;
  }

  async compare(input: {
    evalCase: EvalCase;
    left: RuntimeExecutionEvidence;
    right: RuntimeExecutionEvidence;
    profile: JudgeProfile;
  }): Promise<JudgeResult> {
    if (input.left.status !== "completed" || input.right.status !== "completed") {
      const winner = input.left.status === input.right.status
        ? "tie" as const
        : input.left.status === "completed" ? "left" as const : "right" as const;
      return {
        winner,
        confidence: "high",
        summary: winner === "tie"
          ? "左右两侧均未完成 Runtime 执行，本题不进入专业内容比较。"
          : `${winner === "left" ? "左侧" : "右侧"}完成执行，另一侧发生 Runtime 失败。`,
        dimensions: input.profile.dimensions.map(dimension => ({
          id: dimension.id,
          label: dimension.label,
          leftScore: input.left.status === "completed" ? 1 : 0,
          rightScore: input.right.status === "completed" ? 1 : 0,
          reason: "Runtime 未完成的一侧不进入专业内容比较。",
        })),
        reviewerLabel: "Runtime 完整性判断",
      };
    }
    const swapped = Number.parseInt(fingerprint(input.evalCase.caseId).slice(0, 2), 16) % 2 === 1;
    const a = swapped ? input.right : input.left;
    const b = swapped ? input.left : input.right;
    const messages = [
        {
          role: "system",
          content: [
            input.profile.domainInstructions,
            "匿名比较答案 A 与 B，不推测 Skill 或模型身份。",
            "优先评价专业判断、业务完整性、表达质量和可执行性。",
            "当两份答案都正确时，比较谁更能解释取舍、验证条件和下一步。",
            "Runtime 工具证据是实际执行事实；题面中的系统就绪描述如果没有 Runtime 证据支持，不得覆盖真实工具结果，也不得奖励绕过必需工具的答案。",
            "只返回符合约定的 JSON。",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            task: input.evalCase.prompt,
            evaluationGoal: input.evalCase.evaluationGoal,
            rubric: input.evalCase.rubric,
            outputA: a.output,
            outputB: b.output,
            runtimeEvidenceA: {
              status: a.status,
              toolCalls: a.toolCalls,
              streamCompleted: a.streamCompleted,
            },
            runtimeEvidenceB: {
              status: b.status,
              toolCalls: b.toolCalls,
              streamCompleted: b.streamCompleted,
            },
            responseContract: {
              winner: "A | B | TIE",
              confidence: "low | medium | high",
              summary: "string",
              dimensions: input.profile.dimensions.map(dimension => ({
                id: dimension.id,
                label: dimension.label,
                aScore: "0..4",
                bScore: "0..4",
                reason: "string",
              })),
            },
          }),
        },
      ] as const;
    const request = (attempt: number) => this.adapter.complete({
      requestId: `judge-${input.evalCase.caseId}-${attempt}`,
      model: this.model,
      responseFormat: "json",
      messages: attempt === 1 ? [...messages] : [
        ...messages,
        {
          role: "system" as const,
          content: "上一轮返回未满足 JSON 契约。请直接返回 winner、confidence、summary、dimensions 四个顶层字段，不要复述 responseContract。",
        },
      ],
    });
    let judged: z.infer<typeof anonymousJudgeResponseSchema>;
    try {
      const response = await request(1);
      judged = anonymousJudgeResponseSchema.parse(parseFirstJsonObject(response.content));
    } catch {
      const response = await request(2);
      judged = anonymousJudgeResponseSchema.parse(parseFirstJsonObject(response.content));
    }
    const winner = judged.winner === "TIE"
      ? "tie" as const
      : judged.winner === "A"
        ? swapped ? "right" as const : "left" as const
        : swapped ? "left" as const : "right" as const;
    return judgeResultSchema.parse({
      winner,
      confidence: judged.confidence,
      summary: remapAnonymousSideLabels(judged.summary, swapped),
      dimensions: judged.dimensions.map(dimension => ({
        id: dimension.id,
        label: dimension.label,
        leftScore: swapped ? dimension.bScore : dimension.aScore,
        rightScore: swapped ? dimension.aScore : dimension.bScore,
        reason: remapAnonymousSideLabels(dimension.reason, swapped),
      })),
      reviewerLabel: input.profile.reviewerLabel,
    });
  }
}
