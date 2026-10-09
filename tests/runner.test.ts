import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RuntimeCaseNotExecutedError, RuntimeExecutionFailure } from '../src/adapters.js';
import { renderHtmlReport } from '../src/report.js';
import {
  DeterministicRubricJudge,
  loadEvalPack,
  runEvaluation,
  type RuntimeAdapter,
} from "../src/index.js";

describe("evaluation runner lifecycle", () => {
  it('retains failure correlation without scoring or asserting successful installation', async () => {
    const pack = await loadEvalPack(path.resolve('packs/finance/investment-research/eval.yaml'));
    pack.cases = pack.cases.slice(0, 1);
    const compare = vi.fn(), cleanup = vi.fn(async () => undefined);
    const metadata = {launcherDiagnostics: {basis:'LAUNCHER_CORRELATION_NOT_EXECUTION_VERIFICATION',buildId:'agent-test'}};
    const runtime: RuntimeAdapter = {adapterId:'failed-launcher',
      async execute() {throw new RuntimeExecutionFailure('Runtime execution failed: EVAL_TOOL_EXECUTION_FAILED',metadata);},cleanup};
    const result = await runEvaluation({pack,runtime,judge:{judgeId:'no-score-on-failure',compare}});
    expect(result.cases[0]!.left).toMatchObject({status:'failed',runtimeIdentityVerified:false,loadedSkills:[],metadata});
    expect(compare).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it('records blocked cases as not executed and excludes them from quality scoring', async () => {
    const pack = await loadEvalPack(path.resolve('packs/finance/investment-research/eval.yaml'));
    pack.cases = pack.cases.slice(0, 1);
    const compare = vi.fn();
    const cleanup = vi.fn(async () => undefined);
    const runtime: RuntimeAdapter = {
      adapterId: 'blocked-instance',
      async execute() { throw new RuntimeCaseNotExecutedError('first-failure'); },
      cleanup,
    };
    const result = await runEvaluation({pack, runtime, judge: {judgeId:'never-score-blocked', compare}});
    expect(result.cases[0]!.left.metadata).toEqual({executionDisposition:'NOT_EXECUTED', blockedByCaseId:'first-failure'});
    expect(result.cases[0]!.left.toolCalls).toEqual([]);
    expect(result.cases[0]!.judge).toBeNull();
    expect(renderHtmlReport(result)).toContain('本题未执行');
    expect(compare).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it("cleans up host resources when environment preparation fails", async () => {
    const pack = await loadEvalPack(
      path.resolve("packs/finance/investment-research/eval.yaml"),
    );
    const cleanup = vi.fn(async () => undefined);
    const runtime: RuntimeAdapter = {
      adapterId: "prepare-failure-test",
      async prepare() {
        throw new Error("role authorization missing");
      },
      async execute() {
        throw new Error("execute must not run");
      },
      cleanup,
    };

    await expect(runEvaluation({
      pack,
      runtime,
      judge: new DeterministicRubricJudge(),
    })).rejects.toThrow("role authorization missing");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("stops runtime execution and still cleans up when cancelled", async () => {
    const pack = await loadEvalPack(
      path.resolve("packs/finance/investment-research/eval.yaml"),
    );
    pack.cases = pack.cases.slice(0, 1);
    const controller = new AbortController();
    const cleanup = vi.fn(async () => undefined);
    const onFinalization=vi.fn(async () => undefined);
    const runtime: RuntimeAdapter = {
      adapterId: "cancellation-test",
      async execute(request) {
        controller.abort();
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          if (request.signal?.aborted) reject(new Error("aborted"));
        });
        throw new Error("unreachable");
      },
      cleanup,
      finalizationEvidence:()=>({left:{status:'RELEASED',instanceId:'cancel-instance',buildId:'cancel-build'}}),
    };

    await expect(runEvaluation({
      pack,
      runtime,
      judge: new DeterministicRubricJudge(),
      signal: controller.signal,
      onFinalization,
    })).rejects.toMatchObject({ name: "EvaluationCancelledError" });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onFinalization).toHaveBeenCalledWith(expect.objectContaining({runId:expect.stringContaining('finance-skill-eval-'),
      resources:{left:{status:'RELEASED',instanceId:'cancel-instance',buildId:'cancel-build'}}}));
  });
});
