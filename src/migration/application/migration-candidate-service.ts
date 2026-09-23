import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { z } from "zod";
import { versionedMethod } from "../domain/migration-method-version.js";
import type { MigrationDiagnostics } from "../infrastructure/migration-diagnostics.js";
import type { SkillStore } from "../../service/skill-store.js";
import type { MigrationProjectRepository } from "../infrastructure/migration-project-repository.js";
import { migrationConflict as conflict } from "./migration-errors.js";

const candidateSchema = z.strictObject({
  assetId: z.string().min(1),
  notes: z.string().min(1).max(8000),
});

const draftSchema = z.strictObject({
  source: z.string().min(1).max(128000),
  notes: z.string().min(1).max(8000),
  baseAssetId: z.string().min(1),
  autoVersion: z.boolean().optional(),
});

const reviewSchema = z.strictObject({
  baseAssetId: z.string(),
  decision: z.enum(["ACCEPTED", "NEEDS_CHANGES"]),
  notes: z.string().min(1).max(2000),
});

export class MigrationCandidateService {
  constructor(
    private readonly projects: MigrationProjectRepository,
    private readonly skills: SkillStore,
    private readonly diagnostics?: MigrationDiagnostics,
  ) {}

  async import(id: string, input: unknown) {
    return this.projects.runExclusive(id, async () => {
      const parsed = candidateSchema.parse(input);
      const project = await this.projects.get(id);
      const candidate = await this.skills.get(parsed.assetId);
      if (!candidate || candidate.artifactSha256 === project.source.artifactSha256) {
        return conflict("请作为独立的新版本候选导入；源资产保持不变");
      }
      if (candidate.version === project.source.version) return conflict("候选必须使用新的版本号");
      project.candidate = candidate;
      project.candidateNotes = parsed.notes;
      delete project.inspection;
      project.decisions = [];
      delete project.portableGenerations;
      delete project.portableGenerationDiff;
      (project.candidateHistory ??= []).push({ asset: candidate, notes: parsed.notes, recordedAt: new Date().toISOString() });
      await this.projects.save(project);
      return project;
    });
  }

  async saveDraft(id: string, input: unknown) {
    return this.projects.runExclusive(id, async () => {
      const parsed = draftSchema.parse(input);
      const project = await this.projects.get(id);
      const base = project.candidate ?? project.source;
      if (parsed.baseAssetId !== base.assetId) return conflict("候选已变化，请刷新后再编辑");
      const files = await this.skills.readArchive(base.assetId);
      files[base.skillFile] = strToU8(parsed.autoVersion
        ? versionedMethod(parsed.source, base.skillId, `0.1.0-migration.${(project.candidateHistory?.length ?? 0) + 1}`)
        : parsed.source);
      const candidate = await this.skills.uploadZip(Buffer.from(zipSync(files)));
      if (candidate.version === "0.0.0-upload" || candidate.version === base.version || candidate.version === project.source.version) {
        return conflict("保存前请在 Skill 元数据里写明新的版本号");
      }
      if (candidate.skillId !== base.skillId) return conflict("方法内容的修改不能悄悄改变 Skill 身份");
      project.candidate = candidate;
      project.candidateNotes = parsed.notes;
      (project.candidateHistory ??= []).push({ asset: candidate, notes: parsed.notes, recordedAt: new Date().toISOString() });
      await this.projects.save(project);
      return project;
    });
  }

  async analyze(id: string) {
    const project = await this.projects.get(id);
    const current = project.candidate ?? project.source;
    const source = await this.skills.readSource(project.source.assetId);
    const files = await this.skills.readFiles(current.assetId);
    const archive = await this.skills.readArchive(current.assetId);
    const diagnosis = this.diagnostics ? await this.diagnostics.diagnose(current).catch(() => null) : null;
    return {
      project,
      source,
      candidate: project.candidate ? await this.skills.readSource(project.candidate.assetId) : null,
      diagnosis,
      readableFiles: Object.keys(files),
      inventoryComplete: diagnosis?.status === "COMPLETE",
      fileInventory: Object.entries(archive).map(([name, bytes]) => ({
        name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        executableReviewRequired: /\.(py|sh|js|mjs|cjs|exe|jar)$/i.test(name),
      })),
      unresolved: diagnosis?.findings.filter(finding => finding.layer === "UNKNOWN").map(finding => finding.dependencyType)
        ?? ["DIAGNOSIS_NOT_RUN"],
      analysisMode: "STATIC_INVENTORY_NOT_DEPENDENCY_VALIDATION",
      uploadedScriptsExecuted: false,
    };
  }

  async review(id: string, input: unknown) {
    return this.projects.runExclusive(id, async () => {
      const parsed = reviewSchema.parse(input);
      const project = await this.projects.get(id);
      if (!project.candidate || parsed.baseAssetId !== project.candidate.assetId) {
        return conflict("候选已变化，请对当前版本重新记录专业复核");
      }
      (project.reviews ??= []).push({
        candidateDigest: project.candidate.artifactSha256,
        decision: parsed.decision,
        notes: parsed.notes,
        recordedAt: new Date().toISOString(),
        source: "PRIVATE_ADMIN_RECORDED",
      });
      await this.projects.save(project);
      return project;
    });
  }
}
