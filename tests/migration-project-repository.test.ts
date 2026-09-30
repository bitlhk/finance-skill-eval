import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { MigrationProject } from "../src/migration/domain/migration-project.js";
import { MigrationProjectRepository } from "../src/migration/infrastructure/migration-project-repository.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function repository(): Promise<{ root: string; projects: MigrationProjectRepository }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-projects-"));
  directories.push(root);
  return { root, projects: new MigrationProjectRepository(root) };
}

function project(id = "migration-1234"): MigrationProject {
  return {
    schemaVersion: "finance.skill-migration.v2",
    id,
    name: "example",
    createdAt: "2026-01-01T00:00:00.000Z",
    source: {
      schemaVersion: "finance.skill-eval.skill-asset.v1",
      assetId: "asset-source",
      skillId: "example",
      version: "1.0.0",
      displayName: "Example",
      description: "Example skill",
      sourceType: "uploaded",
      artifactSha256: "a".repeat(64),
      skillFile: "SKILL.md",
      fileCount: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    candidate: null,
    candidateNotes: "",
    runs: [],
    assessment: "NOT_VALIDATED",
  };
}

it("owns migration record persistence and round-trips a project", async () => {
  const { projects } = await repository();
  const value = project();

  await projects.save(value);

  expect(await projects.get(value.id)).toEqual(value);
  expect(await projects.list()).toEqual([value]);
});

it("preserves the public bad-request error for malformed migration ids", async () => {
  const { projects } = await repository();

  await expect(projects.get("../outside")).rejects.toMatchObject({ statusCode: 400 });
});

it("rejects a record whose persisted identity does not match its filename", async () => {
  const { root, projects } = await repository();
  await mkdir(path.join(root, "migrations"), { recursive: true });
  await writeFile(path.join(root, "migrations", "migration-1234.json"), JSON.stringify(project("migration-5678")));

  await expect(projects.get("migration-1234")).rejects.toThrow("记录 ID 与请求不一致");
  await expect(projects.list()).rejects.toThrow("文件名与记录 ID 不一致");
});

it("serializes mutations for the same project key", async () => {
  const { projects } = await repository();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });

  const first = projects.runExclusive("migration-1234", async () => {
    order.push("first:start");
    await gate;
    order.push("first:end");
  });
  const second = projects.runExclusive("migration-1234", async () => {
    order.push("second");
  });
  await Promise.resolve();
  expect(order).toEqual(["first:start"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  expect(order).toEqual(["first:start", "first:end", "second"]);
});

it("preserves every same-project update under concurrent requests", async () => {
  const { projects } = await repository();
  const value = project();
  await projects.save(value);

  await Promise.all(Array.from({ length: 25 }, (_, index) => projects.runExclusive(value.id, async () => {
    const current = await projects.get(value.id);
    current.runs.push({
      jobId: `job-${index}`,
      pair: "AB",
      candidateDigest: `candidate-${index}`,
      comparisonFingerprint: `comparison-${index}`,
      packFingerprint: `pack-${index}`,
    });
    await projects.save(current);
  })));

  const stored = await projects.get(value.id);
  expect(stored.runs).toHaveLength(25);
  expect(new Set(stored.runs.map(run => run.jobId)).size).toBe(25);
});

it("releases a project queue after a failed mutation", async () => {
  const { projects } = await repository();
  await expect(projects.runExclusive("migration-1234", async () => {
    throw new Error("expected failure");
  })).rejects.toThrow("expected failure");

  await expect(projects.runExclusive("migration-1234", async () => "continued")).resolves.toBe("continued");
});
