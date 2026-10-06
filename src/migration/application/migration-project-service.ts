import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MigrationDiagnosisPort } from "./migration-diagnosis-port.js";
import type { MigrationSkillRepository } from "./migration-skill-repository.js";
import type { MigrationProject } from "../domain/migration-project.js";
import type { MigrationProjectStore } from "./migration-project-store.js";
import { migrationConflict as conflict } from "./migration-errors.js";

const createMigrationProjectSchema = z.strictObject({
  sourceAssetId: z.string().min(1),
  name: z.string().min(1).max(120),
  createMode: z.enum(['reuse','new']).default('reuse'),
  revisionOf: z.string().min(1).optional(),
});

export class MigrationProjectService {
  constructor(
    private readonly projects: MigrationProjectStore,
    private readonly skills: MigrationSkillRepository,
    private readonly diagnostics?: MigrationDiagnosisPort,
  ) {}

  list(): Promise<MigrationProject[]> {
    return this.projects.list();
  }

  get(id: string): Promise<MigrationProject> {
    return this.projects.get(id);
  }

  listLegacy(){return this.projects.listLegacy();}
  readLegacy(id:string){return this.projects.readLegacy(id);}

  async create(input: unknown): Promise<MigrationProject> {
    const value = await this.projects.runExclusive("create", async () => {
      const parsed = createMigrationProjectSchema.parse(input);
      const source = await this.skills.get(parsed.sourceAssetId);
      if (!source) return conflict("源 Skill 不可用");

      const existing = (await this.projects.list()).find(project =>
        project.source.artifactSha256 === source.artifactSha256 && project.name === parsed.name);
      if (parsed.revisionOf) {
        const parent = await this.projects.get(parsed.revisionOf);
        if (parsed.createMode !== 'new' || parent.source.artifactSha256 !== source.artifactSha256)
          return conflict('新修订必须引用同一源 Skill');
      }
      if (existing && parsed.createMode === 'reuse') return existing;

      const project: MigrationProject = {
        schemaVersion: "finance.skill-migration.v2",
        id: `migration-${randomUUID()}`,
        name: parsed.name,
        createdAt: new Date().toISOString(),
        ...(parsed.createMode === 'new' && (parsed.revisionOf ?? existing?.id)
          ? {revisionOf: parsed.revisionOf ?? existing!.id} : {}),
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

  async diagnose(id: string, retry = false) {
    const project = await this.get(id);
    if (!this.diagnostics) return conflict("静态诊断服务不可用");
    return this.diagnostics.diagnose(project.source, retry);
  }
}
