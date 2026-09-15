import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  test: {
    include: ["tests/**/*.test.ts"],
    // Service tests create HTTP servers, subprocesses and temporary workspaces.
    // Keep enough parallelism for speed without making Windows scheduling part of the assertion.
    maxWorkers: 4,
    // Service tests drive real HTTP servers, subprocesses and temporary workspaces.
    // The 5s default is below what those take once the machine is loaded, which made
    // results depend on scheduling rather than on the code.
    testTimeout: 30000,
    env: {
      // Tests must not reach a live model or a 60-second agent run. There is no rules fallback
      // any more: a test that needs an inspection stands one in through `migrationAnalyzer`
      // (tests/analysis-fixture.ts) rather than letting a rule invent Tools.
      FINANCE_EVAL_MIGRATION_AGENT: "off",
    },
  },
});
