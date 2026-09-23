import path from "node:path";
import {
  migrationProjectIdSchema,
  parseMigrationProject,
  type MigrationProject,
} from "../domain/migration-project.js";
import { KeyedQueue } from "../../shared/keyed-queue.js";
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

  async list(): Promise<MigrationProject[]> {
    return Promise.all((await listJsonFiles(this.directory)).map(async file => {
      const project = parseMigrationProject(await readJson<unknown>(file));
      if (path.basename(file, ".json") !== project.id) {
        throw new Error(`迁移记录文件名与记录 ID 不一致: ${path.basename(file)}`);
      }
      return project;
    }));
  }

  async get(id: string): Promise<MigrationProject> {
    const project = parseMigrationProject(await readJson<unknown>(this.file(id)));
    if (project.id !== id) throw new Error(`迁移记录 ID 与请求不一致: ${id}`);
    return project;
  }

  async save(project: MigrationProject): Promise<void> {
    const checked = parseMigrationProject(project);
    await writeJsonAtomic(this.file(checked.id), checked);
  }
}
