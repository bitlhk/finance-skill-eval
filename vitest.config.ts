import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  test: {
    include: ["tests/**/*.test.ts"],
    // Service tests create HTTP servers, subprocesses and temporary workspaces.
    // Keep enough parallelism for speed without making Windows scheduling part of the assertion.
    maxWorkers: 4,
    // Service tests drive real HTTP servers, subprocesses and temporary workspaces, and several
    // poll a background job until it finishes. The 5s default was below what those take once the
    // machine is loaded -- and so was 30s, and so were the hand-tuned 10s/30s/45s budgets four
    // tests carried inline. Those overrode this setting, so the suite's real budget was written in
    // four places nobody could compare; the slow ones passed alone and timed out beside a build.
    // One budget, here, oversized on purpose: the cost of a wrong red is higher than a slow hang.
    testTimeout: 90_000,
    env: {
      // Tests must not reach a live model or a 60-second agent run. There is no rules fallback
      // any more: a test that needs an inspection stands one in through `migrationAnalyzer`
      // (tests/analysis-fixture.ts) rather than letting a rule invent Tools.
      FINANCE_EVAL_MIGRATION_AGENT: "off",
    },
  },
});
