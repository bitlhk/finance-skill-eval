import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MigrationDiagnostics } from "../../service/migration-diagnostics.js";
import type { SkillStore } from "../../service/skill-store.js";
import type { MigrationProject } from "../domain/migration-project.js";
import type { MigrationProjectRepository } from "../infrastructure/migration-project-repository.js";

const createMigrationProjectSchema = z.strictObject({
  sourceAssetId: z.string().min(1),
  name: z.string().min(1).max(120),
});

const conflict = (message: string): never => {
  throw Object.assign(new Error(message), { statusCode: 409 });
};

export class MigrationProjectService {
  constructor(
    private readonly projects: MigrationProjectRepository,
    private readonly skills: SkillStore,
    private readonly diagnostics?: MigrationDiagnostics,
  ) {}

  list(): Promise<MigrationProject[]> {
    return this.projects.list();
  }

  get(id: string): Promise<MigrationProject> {
    return this.projects.get(id);
  }

  async create(input: unknown): Promise<MigrationProject> {
    const value = await this.projects.runExclusive("create", async () => {
      const parsed = createMigrationProjectSchema.parse(input);
      const source = await this.skills.get(parsed.sourceAssetId);
      if (!source) return conflict("源 Skill 不可用");

      const existing = (await this.projects.list()).find(project =>
        project.source.artifactSha256 === source.artifactSha256 && project.name === parsed.name);
      if (existing) return existing;

      const project: MigrationProject = {
        schemaVersion: "finance.skill-migration.v2",
        id: `migration-${randomUUID()}`,
        name: parsed.name,
        createdAt: new Date().toISOString(),
        source,
        candidate: null,
        candidateNotes: "",
        runs: [],
        assessment: "NOT_VALIDATED",
      };
      await this.projects.save(project);
      return project;
    });

    void this.diagnostics?.diagnose(value.source).catch(() => undefined);
    return value;
  }

  async upgrade(id: string): Promise<MigrationProject> {
    const legacy = await this.get(id);
    if (legacy.schemaVersion === "finance.skill-migration.v2") return legacy;

    const source = legacy.candidate ?? legacy.source;
    const upgraded = await this.create({ sourceAssetId: source.assetId, name: `${legacy.name} 2.0` });
    return this.projects.runExclusive(upgraded.id, async () => {
      const current = await this.get(upgraded.id);
      if (current.legacySourceProjectId !== legacy.id) {
        current.legacySourceProjectId = legacy.id;
        await this.projects.save(current);
      }
      return current;
    });
  }

  async diagnose(id: string, retry = false) {
    const project = await this.get(id);
    if (!this.diagnostics) return conflict("静态诊断服务不可用");
    return this.diagnostics.diagnose(project.source, retry);
  }
}
