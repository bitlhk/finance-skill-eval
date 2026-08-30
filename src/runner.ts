import { randomUUID } from "node:crypto";
import {
  evaluate,
  type ApiProvider,
  type CallApiContextParams,
  type ProviderResponse,
} from "promptfoo";
import type { EvaluationSide, RuntimeAdapter } from "./adapters.js";
import type { EvalPack, RuntimeExecutionEvidence } from "./contracts.js";
import type { PairwiseJudge } from "./judge.js";
import { buildReport, type EvaluationReport } from "./report.js";

export type EvaluationProgress = {
  stage: "preparing" | "executing" | "judging" | "completed";
  completedRuns: number;
  totalRuns: number;
  caseId?: string;
  side?: EvaluationSide;
  evidence?: RuntimeExecutionEvidence;
};

type EvidenceByCase = Map<string, Partial<Record<EvaluationSide, RuntimeExecutionEvidence>>>;

class AdapterProvider implements ApiProvider {
  constructor(
    private readonly input: {
      runId: string;
      side: EvaluationSide;
      pack: EvalPack;
      runtime: RuntimeAdapter;
      evidence: EvidenceByCase;
      onProgress?: (progress: EvaluationProgress) => void;
      completedRuns: () => number;
      incrementCompletedRuns: () => void;
    },
  ) {}

  id(): string {
    return `finance-skill-eval:${this.input.side}`;
  }

  async callApi(
    _prompt: string,
    context?: CallApiContextParams,
  ): Promise<ProviderResponse> {
    const caseId = String(context?.vars?.caseId ?? "");
    const evalCase = this.input.pack.cases.find(item => item.caseId === caseId);
    if (!evalCase) return { error: `Unknown evaluation case: ${caseId}` };
    const model = this.input.pack.models.execution[this.input.side];
    const variant = this.input.pack.variants[this.input.side];
    let result: RuntimeExecutionEvidence;
    try {
      result = await this.input.runtime.execute({
        runId: this.input.runId,
        side: this.input.side,
        evalCase,
        model,
        variant,
      });
    } catch (error) {
      result = {
        runId: this.input.runId,
        side: this.input.side,
        caseId,
        status: "failed",
        modelId: model.modelId,
        skillVersion: variant.mode === "skill_version" ? variant.version : null,
        output: "",
        elapsedMs: 0,
        toolCalls: [],
        loadedSkills: [],
        usage: null,
        runtimeIdentityVerified: false,
        streamCompleted: false,
        error: error instanceof Error ? error.message : String(error),
        metadata: {},
      };
    }
    const current = this.input.evidence.get(caseId) ?? {};
    current[this.input.side] = result;
    this.input.evidence.set(caseId, current);
    this.input.incrementCompletedRuns();
    this.input.onProgress?.({
      stage: "executing",
      completedRuns: this.input.completedRuns(),
      totalRuns: this.input.pack.cases.length * 2,
      caseId,
      side: this.input.side,
      evidence: result,
    });
    return result.error
      ? { output: result.output || `执行失败：${result.error}` }
      : { output: result.output };
  }
}

export async function runEvaluation(input: {
  pack: EvalPack;
  runtime: RuntimeAdapter;
  judge: PairwiseJudge;
  onProgress?: (progress: EvaluationProgress) => void;
  timeoutMs?: number;
}): Promise<EvaluationReport> {
  const runId = `finance-skill-eval-${randomUUID()}`;
  const evidence: EvidenceByCase = new Map();
  let completedRuns = 0;
  input.onProgress?.({
    stage: "preparing",
    completedRuns,
    totalRuns: input.pack.cases.length * 2,
  });
  try {
    await input.runtime.prepare?.();
    process.env.PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION = "true";
    process.env.PROMPTFOO_DISABLE_TELEMETRY = "true";
    await evaluate(
      {
        description: `${input.pack.packId}@${input.pack.version}`,
        prompts: ["{{prompt}}"],
        providers: (["left", "right"] as const).map(side => new AdapterProvider({
          runId,
          side,
          pack: input.pack,
          runtime: input.runtime,
          evidence,
          onProgress: input.onProgress,
          completedRuns: () => completedRuns,
          incrementCompletedRuns: () => { completedRuns += 1; },
        })),
        tests: input.pack.cases.map(evalCase => ({
          description: `${evalCase.caseId} ${evalCase.name}`,
          vars: { caseId: evalCase.caseId, prompt: evalCase.prompt },
        })),
        writeLatestResults: false,
      },
      {
        cache: false,
        generateSuggestions: false,
        maxConcurrency: 1,
        showProgressBar: false,
        silent: true,
        timeoutMs: input.timeoutMs ?? 310_000,
      },
    );
    input.onProgress?.({
      stage: "judging",
      completedRuns,
      totalRuns: input.pack.cases.length * 2,
    });
    const cases = [];
    for (const evalCase of input.pack.cases) {
      const result = evidence.get(evalCase.caseId);
      if (!result?.left || !result.right) {
        throw new Error(`Promptfoo did not produce both sides for ${evalCase.caseId}`);
      }
      let judge = null;
      let judgeError = null;
      try {
        judge = await input.judge.compare({
          evalCase,
          left: result.left,
          right: result.right,
          profile: input.pack.judgeProfile,
        });
      } catch (error) {
        judgeError = error instanceof Error ? error.message : String(error);
      }
      cases.push({
        caseId: evalCase.caseId,
        name: evalCase.name,
        prompt: evalCase.prompt,
        evaluationGoal: evalCase.evaluationGoal,
        left: result.left,
        right: result.right,
        judge,
        judgeError,
      });
    }
    const report = buildReport({
      pack: input.pack,
      runtimeAdapterId: input.runtime.adapterId,
      judgeId: input.judge.judgeId,
      cases,
      reportId: runId,
    });
    input.onProgress?.({
      stage: "completed",
      completedRuns,
      totalRuns: input.pack.cases.length * 2,
    });
    return report;
  } finally {
    await input.runtime.cleanup?.();
  }
}
