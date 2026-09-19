import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  test: {
    include: ["tests/**/*.test.ts"],
    // Service tests create HTTP servers, subprocesses and temporary workspaces.
    // Keep enough parallelism for speed without making Windows scheduling part of the assertion.
    maxWorkers: 4,
  },
});
