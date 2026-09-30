import path from "node:path";
import {
  migrationProjectIdSchema,
  parseMigrationProject,
  type MigrationProject,
} from "../domain/migration-project.js";
import { KeyedQueue } from "../../shared/keyed-queue.js";
import { copyFile, access } from "node:fs/promises";
import { listJsonFiles, readJson, writeJsonAtomic } from "../../service/file-store.js";
import type { MigrationProjectStore } from "../application/migration-project-store.js";

export class MigrationProjectRepository implements MigrationProjectStore {
  private readonly directory: string;
  private readonly mutations = new KeyedQueue();

  constructor(dataDirectory: string) {
    this.directory = path.join(dataDirectory, "migrations");
  }

  private file(id: string): string {
    if (!migrationProjectIdSchema.safeParse(id).success) {
      throw Object.assign(new Error("迁移记录 ID 不合法"), { statusCode: 400 });
    }
    return path.join(this.directory, `${id}.json`);
  }

  runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.mutations.run(key, operation);
  }

  private async parseOrUpgrade(file: string, raw: unknown): Promise<MigrationProject | null> {
    const record = raw as { schemaVersion?: string; id?: string } | null;
    if (record?.schemaVersion === "finance.skill-migration.v2") return parseMigrationProject(raw);
    if (record?.schemaVersion !== "finance.skill-migration.v0.1") return null;

    const backup = `${file}.v0.1.backup.json`;
    try { await access(backup); } catch { await copyFile(file, backup); }
    const upgraded = parseMigrationProject({ ...(raw as Record<string, unknown>), schemaVersion: "finance.skill-migration.v2" });
    await writeJsonAtomic(file, upgraded);
    return upgraded;
  }

  async list(): Promise<MigrationProject[]> {
    const projects = await Promise.all((await listJsonFiles(this.directory)).map(async file => {
      const raw = await readJson<unknown>(file);
      const project = await this.parseOrUpgrade(file, raw);
      if (!project) return null;
      if (path.basename(file, ".json") !== project.id) {
        throw new Error(`迁移记录文件名与记录 ID 不一致: ${path.basename(file)}`);
      }
      return project;
    }));
    return projects.filter((project): project is MigrationProject => project !== null);
  }

  async get(id: string): Promise<MigrationProject> {
    const raw = await readJson<unknown>(this.file(id));
    const project = await this.parseOrUpgrade(this.file(id), raw);
    if (!project) throw Object.assign(new Error("不支持的迁移记录版本"), { statusCode: 410 });
    if (project.id !== id) throw new Error(`迁移记录 ID 与请求不一致: ${id}`);
    return project;
  }

  async save(project: MigrationProject): Promise<void> {
    const checked = parseMigrationProject(project);
    await writeJsonAtomic(this.file(checked.id), checked);
  }
}
