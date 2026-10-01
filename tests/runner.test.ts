import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RuntimeCaseNotExecutedError } from '../src/adapters.js';
import { renderHtmlReport } from '../src/report.js';
import {
  DeterministicRubricJudge,
  loadEvalPack,
  runEvaluation,
  type RuntimeAdapter,
} from "../src/index.js";

describe("evaluation runner lifecycle", () => {
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
    };

    await expect(runEvaluation({
      pack,
      runtime,
      judge: new DeterministicRubricJudge(),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "EvaluationCancelledError" });
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
