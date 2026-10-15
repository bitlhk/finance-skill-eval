import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { z } from "zod";
import { versionedMethod } from "../domain/migration-method-version.js";
import type { MigrationDiagnosisPort } from "./migration-diagnosis-port.js";
import type { MigrationSkillRepository } from "./migration-skill-repository.js";
import type { MigrationProjectStore } from "./migration-project-store.js";
import { migrationConflict as conflict } from "./migration-errors.js";
import type {MigrationCandidateInspectionService} from './migration-candidate-inspection-service.js';
import {currentReuseProposal} from '../domain/migration-reuse-design.js';

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
    private readonly projects: MigrationProjectStore,
    private readonly skills: MigrationSkillRepository,
    private readonly diagnostics?: MigrationDiagnosisPort,
    private readonly candidateInspection?: Pick<MigrationCandidateInspectionService,'inspectRevision'>,
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
      const base=project.candidate??project.source;
      if(candidate.skillId!==base.skillId)return conflict('候选不能悄悄改变 Skill 身份');
      if(project.generationAttempts?.at(-1)?.progress.status==='RUNNING'
        ||project.reuseAcceptanceResults?.some(task=>task.status==='RUNNING')
        ||project.improvementTasks?.some(task=>['RUNNING','WAITING_BUILDER','WAITING_CONFIGURATION'].includes(task.status)))
        return conflict('迁移任务进行中，不能替换候选');
      const revision=Boolean(project.candidate&&project.reuseProposal&&project.portableGenerations);
      const proposal=revision?currentReuseProposal(project):null;
      let inspection;
      if(revision){
        if(!proposal?.approvedAt)return conflict('迁移方案已失效，请重新确认后导入修复候选');
        if(candidate.artifactSha256===base.artifactSha256||candidate.version===base.version)
          return conflict('修复候选必须是独立的新版本');
        if(!this.candidateInspection)return conflict('候选方案审查服务不可用');
        const files=await this.skills.readArchive(candidate.assetId);
        for(const generation of project.portableGenerations??[]){
          if(generation.files.some(file=>!files[file])||(generation.entrypoint&&!files[generation.entrypoint]))
            return conflict('修复候选缺少已声明的工具文件，请重新生成或调整迁移方案');
        }
        // Review before changing the active project. Failed analysis must leave the old candidate intact.
        inspection=await this.candidateInspection.inspectRevision(project,candidate);
      }
      project.candidate = candidate;
      project.candidateNotes = parsed.notes;
      delete project.analysis;
      if(inspection){
        project.inspection=inspection;
        project.candidateReuseProposalId=proposal!.proposalId;
        project.decisions=(project.decisions??[]).map(item=>item.baseAssetId===base.assetId?{...item,baseAssetId:candidate.assetId}:item);
        project.portableGenerations=project.portableGenerations!.map(({checks,...item})=>({...item,callExecuted:false,
          generatedBy:'MANUAL_REVISION',explanation:'已重新审查修复候选；启动配置沿用声明，实际执行需要重新验证。'}));
      }else{
        delete project.inspection;
        delete project.candidateReuseProposalId;
        project.decisions = [];
        delete project.portableGenerations;
      }
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
