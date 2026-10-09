import { strToU8, zipSync } from "fflate";
import { z } from "zod";
import {projectMigrationPlan} from '../domain/migration-reuse-design.js';
import type { MigrationSkillRepository } from "./migration-skill-repository.js";
import type { MigrationProjectStore } from "./migration-project-store.js";
import { migrationConflict as conflict } from "./migration-errors.js";
import type { MigrationSupplementRepository } from './migration-supplement-repository.js';
import type { MigrationCandidatePackager } from './migration-candidate-packager.js';
import type { MigrationImplementationService } from './migration-implementation-service.js';
import type { MigrationCandidateInspectionService } from './migration-candidate-inspection-service.js';
import type {GenerationPhase,MigrationGenerationProgress} from '../domain/migration-generation-progress.js';

export class MigrationGenerationService {
  private readonly progress=new Map<string,MigrationGenerationProgress>();
  constructor(
    private readonly projects: MigrationProjectStore,
    private readonly skills: MigrationSkillRepository,
    private readonly supplements:MigrationSupplementRepository,
    private readonly packager:MigrationCandidatePackager,
    private readonly implementations:MigrationImplementationService,
    private readonly candidateInspection:MigrationCandidateInspectionService,
  ) {}

  async executionProgress(id:string){
    await this.projects.get(id);
    const value=this.progress.get(id);if(!value)return null;
    const snapshot=structuredClone(value);
    if(snapshot.status==='RUNNING'){
      snapshot.elapsedMs=Date.now()-Date.parse(snapshot.startedAt);
      const current=snapshot.steps.at(-1);if(current)current.elapsedMs=Date.now()-Date.parse(current.startedAt);
    }
    return snapshot;
  }

  async generate(id: string, input: unknown) {
    return this.projects.runExclusive(id, async () => {
      const state:MigrationGenerationProgress={status:'RUNNING',startedAt:new Date().toISOString(),elapsedMs:0,steps:[]};
      const phase=(phase:GenerationPhase)=>{
        const previous=state.steps.at(-1);if(previous)previous.elapsedMs=Date.now()-Date.parse(previous.startedAt);
        state.steps.push({phase,startedAt:new Date().toISOString(),elapsedMs:0});
      };
      phase('PREPARING');
      try{
      const parsed = z.strictObject({
        baseAssetId: z.string().min(1),
        acknowledgePartialAnalysis: z.boolean().optional(),
      }).parse(input);
      const project = await this.projects.get(id);
      this.progress.set(id,state);
      const currentAsset = project.candidate ?? project.source;
      if (parsed.baseAssetId !== currentAsset.assetId) return conflict("资产已变化，请刷新后重新生成");
      if (!project.inspection || project.inspection.assetId !== currentAsset.assetId) return conflict("请先检查当前资产");
      const generationInspection = project.sourceInspection ?? project.inspection;
      const supplementRecord=await this.supplements.get(id);
      if(generationInspection.dependencyAnalysis?.materialsDigest!==this.supplements.digest(supplementRecord))return conflict('补充材料已变化，请重新分析并确认迁移方案');
      if (!generationInspection.staticAnalysis || generationInspection.staticAnalysis.status === "UNAVAILABLE") {
        return conflict("静态分析不可用，已阻止生成候选");
      }
      const toolPaths = new Set(generationInspection.tools.flatMap(tool => tool.sourcePaths));
      const incompleteFiles = generationInspection.staticAnalysis.toolIncompleteFiles
        ?? generationInspection.staticAnalysis.incompleteFiles.filter(item => toolPaths.has(item.path));
      if (incompleteFiles.length && !parsed.acknowledgePartialAnalysis) {
        return conflict(`静态分析未完整覆盖 Tool 相关源码；确认人工审阅后才能继续：${incompleteFiles.map(item => `${item.path} (${item.status})`).join("、")}`);
      }

      const plan = projectMigrationPlan(project)!;
      if (!plan.generationAllowed) return conflict(plan.skillBlockingReasons.join('；')||'工具选择尚不能生成候选');
      const archive = await this.skills.readArchive(project.source.assetId);
      const version = `2.0.0-migration.${(project.candidateHistory?.length ?? 0) + 1}`;
      for (const supplement of supplementRecord.items) {
        for (const [name, content] of Object.entries(supplement.files ?? {})) archive[name] = Buffer.from(content, "base64");
      }
      const decisions = project.decisions!.filter(decision => decision.baseAssetId === currentAsset.assetId);
      phase('GENERATING');
      const delivery = await this.implementations.generate(archive, generationInspection, decisions, project.source, plan);
      phase('PACKAGING');
      const generated = this.packager.package({
        archive,
        base: project.source,
        inspection: generationInspection,
        decisions,
        version,
        ...delivery,
      });
      if (generationInspection.dependencyAnalysis?.dependencies.length) {
        const dependencyPath = decisions.some(decision => decision.form === "MCP")
          ? "runtime-dependencies.json"
          : "scripts/runtime-dependencies.json";
        if (generated.files[dependencyPath]) return conflict("生成工程占用了运行依赖声明路径，请调整后重新生成");
        const declarations = generationInspection.tools.map(tool => ({
          tool: tool.name,
          dependencies: generationInspection.dependencyAnalysis!.dependencies
            .filter(dependency => dependency.toolIds.includes(tool.toolId) && dependency.owner === "RUNTIME" && dependency.action === "INJECT")
            .map(dependency => ({
              name: dependency.name,
              key: dependency.key,
              purpose: dependency.purpose,
              required: dependency.blocking,
              sensitive: dependency.sensitive,
              schema: dependency.schema,
              binding: dependency.binding,
            })),
        }));
        const content = `${JSON.stringify({ schemaVersion: "finance.tool-runtime-dependencies.v1", tools: declarations }, null, 2)}\n`;
        generated.files[dependencyPath] = strToU8(content);
        generated.diff.push({ path: dependencyPath, operation: "ADD", before: "", after: content });
      }

      const candidate = await this.skills.uploadZip(Buffer.from(zipSync(generated.files)), { version });
      const candidateInspection = await this.candidateInspection.inspect({
        candidate,
        files: generated.files,
        inspection: generationInspection,
        decisions: project.decisions!,
        baseAssetId: currentAsset.assetId,
        generations: generated.generations,
        reuseProposal:plan.reuseProposal??undefined,
        onPhase:phase,
        sourceFiles:Object.fromEntries(Object.entries(archive).flatMap(([name,bytes])=>{try{return [[name,new TextDecoder('utf-8',{fatal:true}).decode(bytes)]]}catch{return []}})),
      });
      const carriedDecisions = decisions.map(decision => ({
        ...decision,
        baseAssetId: candidate.assetId,
        decidedAt: new Date().toISOString(),
      }));
      project.decisions = [...(project.decisions ?? []), ...carriedDecisions];
      project.candidate = candidate;
      project.candidateReuseProposalId=plan.reuseProposal!.proposalId;
      project.inspection = candidateInspection;
      project.candidateNotes = "按已确认的可复用迁移方案生成候选，已重新分析产物并检查方案落实情况；业务验收待运行。";
      project.portableGenerations = generated.generations;
      project.generationStats = delivery.generationStats;
      project.portableGenerationDiff = generated.diff;
      (project.candidateHistory ??= []).push({
        asset: candidate,
        notes: project.candidateNotes,
        recordedAt: new Date().toISOString(),
        kind: "migration",
      });
      await this.projects.save(project);
      state.status='COMPLETED';
      return project;
      }catch(error){state.status='FAILED';throw error;}
      finally{
        state.finishedAt=new Date().toISOString();state.elapsedMs=Date.parse(state.finishedAt)-Date.parse(state.startedAt);
        const last=state.steps.at(-1);if(last)last.elapsedMs=Date.parse(state.finishedAt)-Date.parse(last.startedAt);
      }
    });
  }

}
