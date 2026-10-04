import { z } from "zod";
import {judgeCaseFiles,caseFileJudgeGuidance} from './judge-case-files.js';
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
  readonly assessesSidesIndependently?: boolean;
  compare(input: {
    signal?: AbortSignal;
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
    signal?: AbortSignal;
    evalCase: EvalCase;
    left: RuntimeExecutionEvidence;
    right: RuntimeExecutionEvidence;
    profile: JudgeProfile;
  }): Promise<JudgeResult> {
    if(input.evalCase.rubric.some(c=>c.allOf.length+c.anyOf.length+c.noneOf.length===0)) {
      throw new Error('当前量表包含专业判断项，未定义可复算规则，请使用模型 Judge。');
    }
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
    const bothFullyCovered = leftChecks.length > 0
      && leftChecks.every(check => check.passed)
      && rightChecks.every(check => check.passed);
    const neitherCovered = !leftChecks.some(check => check.passed)
      && !rightChecks.some(check => check.passed);
    return {
      winner,
      confidence: difference >= 4 ? "high" : difference >= 2 ? "medium" : "low",
      summary: winner === "tie"
        ? bothFullyCovered
          ? "两侧均满足当前确定性规则；专业判断与表达质量仍需另行评估。"
          : neitherCovered
            ? "两侧均未满足当前确定性规则；请核对回答、规则及执行证据，不能据此认定业务通过。"
            : "两侧确定性规则得分相同，但未全部满足规则；请查看各维度结果与未覆盖要求。"
        : `${winner === "left" ? "左侧" : "右侧"}在当前确定性规则中得分更高；不代表完整专业质量验收通过。`,
      dimensions,
      reviewerLabel: input.profile.reviewerLabel,
    };
  }
}

const judgeDimensionIds = [
  "professional_fit",
  "business_completeness",
  "clarity",
  "actionability",
] as const;
const judgeDimensionIdSchema = z.enum(judgeDimensionIds);

function completeDimensions<T extends { id: string }>(dimensions: T[], context: z.RefinementCtx): void {
  for (const id of judgeDimensionIds) {
    if (dimensions.filter(dimension => dimension.id === id).length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Judge dimension must appear exactly once: ${id}`,
      });
    }
  }
}

function dimensionsInProfileOrder<T extends { id: string }>(profile: JudgeProfile, dimensions: T[]) {
  return profile.dimensions.map(profileDimension => {
    const judgment = dimensions.find(dimension => dimension.id === profileDimension.id);
    if (!judgment) throw new Error(`Judge dimension is missing: ${profileDimension.id}`);
    return { profileDimension, judgment };
  });
}

const anonymousJudgeResponseSchema = z.strictObject({
  winner: z.enum(["A", "B", "TIE"]),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string().min(1),
  dimensions: z.array(z.strictObject({
    id: judgeDimensionIdSchema,
    aScore: z.number().min(0).max(4),
    bScore: z.number().min(0).max(4),
    reason: z.string().min(1),
  })).length(4).superRefine(completeDimensions),
});

const candidateJudgeResponseSchema = z.strictObject({
  confidence:z.enum(["low","medium","high"]),summary:z.string().min(1),
  dimensions:z.array(z.strictObject({
    id:judgeDimensionIdSchema,score:z.number().min(0).max(4),reason:z.string().min(1),
  })).length(4).superRefine(completeDimensions),
});

/** Absolute quality assessment for a migrated candidate. It deliberately has no winning side. */
export class ModelCandidateJudge implements PairwiseJudge {
  readonly judgeId:string;
  constructor(private readonly adapter:ModelAdapter,private readonly model:ModelRef){
    this.judgeId=`model-candidate:${adapter.adapterId}:${model.providerId}:${model.modelId}`;
  }
  async compare(input:{signal?:AbortSignal;evalCase:EvalCase;left:RuntimeExecutionEvidence;right:RuntimeExecutionEvidence;profile:JudgeProfile}):Promise<JudgeResult>{
    if(input.right.status!=="completed")return judgeResultSchema.parse({winner:"tie",confidence:"high",summary:"迁移候选未完成 Runtime 执行，本题不进行 Skill 质量评分。",
      dimensions:input.profile.dimensions.map(dimension=>({id:dimension.id,label:dimension.label,leftScore:0,rightScore:0,reason:"Runtime 执行未完成。"})),reviewerLabel:"Runtime 完整性判断"});
    const businessEvidence={status:input.right.status,toolCalls:input.right.toolCalls.filter(call=>call.name!=="read_file"),streamCompleted:input.right.streamCompleted,
      sourceFacts:Array.isArray(input.right.metadata.toolEvidence)?input.right.metadata.toolEvidence.filter((item:{tool?:string})=>item.tool!=="read_file"):[],
      sourceFactsCollection:input.right.metadata.toolEvidenceCollection,
      caseFiles:judgeCaseFiles(input.evalCase,input.right),
      caseFileEvidenceScope:input.evalCase.workspaceFiles?.length?caseFileJudgeGuidance:undefined};
    const messages=[{role:"system" as const,content:[input.profile.domainInstructions,"这是迁移候选的绝对质量评估，不与无 Skill 或其他候选比较，也不选择胜方。","按专业判断、业务完整性、表达质量和可执行性逐项给 0–4 分。","Runtime 工具证据是实际执行事实；没有证据时不得把题面中的就绪描述当成已完成调用。","只返回符合约定的 JSON。"].join("\n")},
      {role:"user" as const,content:JSON.stringify({task:input.evalCase.prompt,evaluationGoal:input.evalCase.evaluationGoal,rubric:input.evalCase.rubric,candidateOutput:input.right.output,runtimeEvidence:businessEvidence,
        responseContract:{confidence:"low | medium | high",summary:"string",scoreRule:"score must be a JSON integer from 0 to 4",dimensions:input.profile.dimensions.map(dimension=>({id:dimension.id,score:0,reason:"string"}))}})}];
    const request=(attempt:number)=>this.adapter.complete({requestId:`candidate-judge-${input.evalCase.caseId}-${attempt}`,model:this.model,signal:input.signal,responseFormat:"json",
      messages:attempt===1?messages:[...messages,{role:"system" as const,content:"上一轮返回未满足 JSON 契约。直接返回 confidence、summary、dimensions 三个顶层字段；每个 dimensions 项必须包含不重复的 id、score、reason。"}]});
    let judged:z.infer<typeof candidateJudgeResponseSchema>;
    try{judged=candidateJudgeResponseSchema.parse(parseFirstJsonObject((await request(1)).content));}
    catch(error){if(input.signal?.aborted)throw error;judged=candidateJudgeResponseSchema.parse(parseFirstJsonObject((await request(2)).content));}
    return judgeResultSchema.parse({winner:"tie",confidence:judged.confidence,summary:judged.summary,
      dimensions:dimensionsInProfileOrder(input.profile,judged.dimensions).map(({profileDimension,judgment})=>({id:profileDimension.id,label:profileDimension.label,leftScore:judgment.score,rightScore:judgment.score,reason:judgment.reason})),
      reviewerLabel:`AI 候选质量评估 · ${this.model.modelId}（非独立人类专家签署）`});
  }
}

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
    signal?: AbortSignal;
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
    const businessEvidence = (evidence: RuntimeExecutionEvidence) => ({
      sourceFacts: Array.isArray(evidence.metadata.toolEvidence)
        ? evidence.metadata.toolEvidence.filter((item: { tool?: string }) => item.tool !== "read_file") : [],
      sourceFactsCollection: evidence.metadata.toolEvidenceCollection,
      caseFiles:judgeCaseFiles(input.evalCase,evidence),
      caseFileEvidenceScope:input.evalCase.workspaceFiles?.length?caseFileJudgeGuidance:undefined,
      status: evidence.status,
      toolCalls: evidence.toolCalls.filter(call => call.name !== "read_file"),
      streamCompleted: evidence.streamCompleted,
    });
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
            runtimeEvidenceA: businessEvidence(a),
            runtimeEvidenceB: businessEvidence(b),
            responseContract: {
              winner: "A | B | TIE",
              confidence: "low | medium | high",
              summary: "string",
              scoreRule: "aScore and bScore must be JSON integers from 0 to 4, not strings",
              dimensions: input.profile.dimensions.map(dimension => ({
                id: dimension.id,
                aScore: 0,
                bScore: 0,
                reason: "string",
              })),
            },
          }),
        },
      ] as const;
    const request = (attempt: number) => this.adapter.complete({
      requestId: `judge-${input.evalCase.caseId}-${attempt}`,
      model: this.model,
      signal: input.signal,
      responseFormat: "json",
      messages: attempt === 1 ? [...messages] : [
        ...messages,
        {
          role: "system" as const,
          content: "上一轮返回未满足 JSON 契约。请直接返回 winner、confidence、summary、dimensions 四个顶层字段，不要复述 responseContract；每个 dimensions 项必须包含不重复的 id、aScore、bScore、reason。",
        },
      ],
    });
    let judged: z.infer<typeof anonymousJudgeResponseSchema>;
    try {
      const response = await request(1);
      judged = anonymousJudgeResponseSchema.parse(parseFirstJsonObject(response.content));
    } catch (error) {
      if (input.signal?.aborted) throw error;
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
      dimensions: dimensionsInProfileOrder(input.profile, judged.dimensions).map(({ profileDimension, judgment }) => ({
        id: profileDimension.id,
        label: profileDimension.label,
        leftScore: swapped ? judgment.bScore : judgment.aScore,
        rightScore: swapped ? judgment.aScore : judgment.bScore,
        reason: remapAnonymousSideLabels(judgment.reason, swapped),
      })),
      reviewerLabel: `AI 专业盲评 · ${this.model.modelId}（非独立人类专家签署）`,
    });
  }
}
