import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvaluationSide, RuntimeAdapter, RuntimeEvent } from "./adapters.js";
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
  event?: RuntimeEvent;
};

type EvidenceByCase = Map<string, Partial<Record<EvaluationSide, RuntimeExecutionEvidence>>>;

type WorkerExecuteMessage = {
  type: "execute";
  requestId: string;
  side: EvaluationSide;
  caseId: string;
};

type WorkerTerminalMessage =
  | { type: "completed" }
  | { type: "error"; error: string };

export class EvaluationCancelledError extends Error {
  constructor(message = "Evaluation cancelled") {
    super(message);
    this.name = "EvaluationCancelledError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EvaluationCancelledError();
}

function promptfooWorkerPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const sibling = join(currentDir, "promptfoo-worker.js");
  if (existsSync(sibling)) return sibling;
  const compiled = join(currentDir, "..", "dist", "promptfoo-worker.js");
  if (existsSync(compiled)) return compiled;
  throw new Error("Promptfoo worker is unavailable; build finance-skill-eval before running evaluations");
}

function sendWorkerMessage(child: ChildProcess, message: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(new Error("Promptfoo worker disconnected"));
      return;
    }
    child.send(message, error => error ? reject(error) : resolve());
  });
}

async function executeRuntime(input: {
  onEvent?: (event: RuntimeEvent) => void;
  runId: string;
  side: EvaluationSide;
  caseId: string;
  pack: EvalPack;
  runtime: RuntimeAdapter;
  signal?: AbortSignal;
}): Promise<RuntimeExecutionEvidence> {
  throwIfAborted(input.signal);
  const evalCase = input.pack.cases.find(item => item.caseId === input.caseId);
  if (!evalCase) throw new Error(`Unknown evaluation case: ${input.caseId}`);
  const model = input.pack.models.execution[input.side];
  const variant = input.pack.variants[input.side];
  const startedAt = Date.now();
  try {
    return await input.runtime.execute({
      runId: input.runId,
      side: input.side,
      evalCase,
      model,
      variant,
      signal: input.signal,
      onEvent: input.onEvent,
    });
  } catch (error) {
    if (input.signal?.aborted || error instanceof EvaluationCancelledError) throw error;
    return {
      runId: input.runId,
      side: input.side,
      caseId: input.caseId,
      status: "failed",
      modelId: model.modelId,
      skillVersion: variant.mode === "skill_version" ? variant.version : null,
      output: "",
      elapsedMs: Date.now() - startedAt,
      toolCalls: [],
      loadedSkills: [],
      usage: null,
      runtimeIdentityVerified: false,
      streamCompleted: false,
      error: error instanceof Error ? error.message : String(error),
      metadata: {},
    };
  }
}

async function runPromptfooWorker(input: {
  runId: string;
  pack: EvalPack;
  runtime: RuntimeAdapter;
  evidence: EvidenceByCase;
  onProgress?: (progress: EvaluationProgress) => void;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(input.signal);
  let completedRuns = 0;
  const child = fork(promptfooWorkerPath(), [], {
    env: {
      ...process.env,
      PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION: "true",
      PROMPTFOO_DISABLE_TELEMETRY: "true",
    },
    serialization: "json",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let terminal = false;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => finish(new EvaluationCancelledError());
    const finish = (error?: Error) => {
      if (terminal) return;
      terminal = true;
      input.signal?.removeEventListener("abort", onAbort);
      if (child.connected) child.disconnect();
      if (!child.killed) child.kill("SIGTERM");
      if (error) reject(error);
      else resolve();
    };
    child.on("message", message => {
      const workerMessage = message as WorkerExecuteMessage | WorkerTerminalMessage;
      if (workerMessage.type === "completed") {
        finish();
        return;
      }
      if (workerMessage.type === "error") {
        finish(new Error(workerMessage.error));
        return;
      }
      if (workerMessage.type !== "execute") return;
      void (async () => {
        const result = await executeRuntime({
          runId: input.runId,
          side: workerMessage.side,
          caseId: workerMessage.caseId,
          pack: input.pack,
          runtime: input.runtime,
          signal: input.signal,
          onEvent: event => input.onProgress?.({ stage: "executing", completedRuns,
            totalRuns: input.pack.cases.length * 2, caseId: event.caseId, side: event.side, event }),
        });
        const current = input.evidence.get(workerMessage.caseId) ?? {};
        current[workerMessage.side] = result;
        input.evidence.set(workerMessage.caseId, current);
        completedRuns += 1;
        input.onProgress?.({
          stage: "executing",
          completedRuns,
          totalRuns: input.pack.cases.length * 2,
          caseId: workerMessage.caseId,
          side: workerMessage.side,
          evidence: result,
        });
        await sendWorkerMessage(child, {
          type: "executionResult",
          requestId: workerMessage.requestId,
          output: result.error
            ? result.output || `执行失败：${result.error}`
            : result.output,
        });
      })().catch(error => finish(error instanceof Error ? error : new Error(String(error))));
    });
    child.once("error", error => finish(error));
    child.once("exit", (code, signal) => {
      if (terminal) return;
      finish(new Error(
        `Promptfoo worker exited before completion (code=${code ?? "null"}, signal=${signal ?? "none"})`,
      ));
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    void sendWorkerMessage(child, {
      type: "start",
      description: `${input.pack.packId}@${input.pack.version}`,
      cases: input.pack.cases.map(evalCase => ({
        caseId: evalCase.caseId,
        name: evalCase.name,
        prompt: evalCase.prompt,
      })),
      timeoutMs: input.timeoutMs,
    }).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

export async function runEvaluation(input: {
  pack: EvalPack;
  runtime: RuntimeAdapter;
  judge: PairwiseJudge;
  onProgress?: (progress: EvaluationProgress) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
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
    throwIfAborted(input.signal);
    await input.runtime.prepare?.({runId,signal:input.signal});
    throwIfAborted(input.signal);
    await runPromptfooWorker({
      runId,
      pack: input.pack,
      runtime: input.runtime,
      evidence,
      onProgress: progress => {
        completedRuns = progress.completedRuns;
        input.onProgress?.(progress);
      },
      timeoutMs: input.timeoutMs ?? 310_000,
      signal: input.signal,
    });
    throwIfAborted(input.signal);
    input.onProgress?.({
      stage: "judging",
      completedRuns,
      totalRuns: input.pack.cases.length * 2,
    });
    const cases = [];
    for (const evalCase of input.pack.cases) {
      throwIfAborted(input.signal);
      const result = evidence.get(evalCase.caseId);
      if (!result?.left || !result.right) {
        throw new Error(`Promptfoo did not produce both sides for ${evalCase.caseId}`);
      }
      let judge = null;
      let judgeError = null;
      try {
        if (!input.judge.assessesSidesIndependently && (result.left.status !== "completed" || result.right.status !== "completed")) {
          throw new Error("执行未完成，不计入专业质量评分；请修复运行环境后重测。");
        }
        judge = await input.judge.compare({
          signal: input.signal,
          evalCase,
          left: result.left,
          right: result.right,
          profile: input.pack.judgeProfile,
        });
        throwIfAborted(input.signal);
      } catch (error) {
        if (input.signal?.aborted || error instanceof EvaluationCancelledError) throw error;
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
