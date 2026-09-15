import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  test: {
    include: ["tests/**/*.test.ts"],
    // Service tests create HTTP servers, subprocesses and temporary workspaces.
    // Keep enough parallelism for speed without making Windows scheduling part of the assertion.
    maxWorkers: 4,
    env: {
      // Tests must not reach a live model or a 60-second agent run. The store falls
      // back to the deterministic rules path when the agent is off.
      FINANCE_EVAL_MIGRATION_AGENT: "off",
    },
  },
});
