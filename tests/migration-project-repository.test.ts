import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

it("does not block mutations for different project keys", async () => {
  const { projects } = await repository();
  let releaseFirst: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const first = projects.runExclusive("migration-1234", async () => gate);
  let secondFinished = false;
  await projects.runExclusive("migration-5678", async () => { secondFinished = true; });
  expect(secondFinished).toBe(true);
  releaseFirst?.();
  await first;
});

it("upgrades a v0.1 project in place, preserves its data and writes an audit backup", async () => {
  const { root, projects } = await repository();
  const directory = path.join(root, "migrations");
  await mkdir(directory, { recursive: true });
  const legacy = { ...project(), schemaVersion: "finance.skill-migration.v0.1", legacySourceProjectId: "source-project", targetRuns: ["run-1"] };
  const file = path.join(directory, `${legacy.id}.json`);
  await writeFile(file, JSON.stringify(legacy));

  const upgraded = await projects.get(legacy.id);

  expect(upgraded).toMatchObject({ schemaVersion: "finance.skill-migration.v2", id: legacy.id, legacySourceProjectId: "source-project", targetRuns: ["run-1"] });
  expect(JSON.parse(await readFile(`${file}.v0.1.backup.json`, "utf8"))).toEqual(legacy);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ schemaVersion: "finance.skill-migration.v2", id: legacy.id });
});

it("rejects malformed v2 core fields instead of trusting the version discriminator", async () => {
  const { root, projects } = await repository();
  await mkdir(path.join(root, "migrations"), { recursive: true });
  await writeFile(path.join(root, "migrations", "migration-1234.json"), JSON.stringify({ schemaVersion: "finance.skill-migration.v2", id: "migration-1234" }));
  await expect(projects.get("migration-1234")).rejects.toMatchObject({ name: "ZodError" });
});
