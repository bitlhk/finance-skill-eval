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
import {MigrationGenerationError,generationPhaseLabels,type GenerationPhase,type MigrationGenerationProgress,type MigrationGenerationAttempt} from '../domain/migration-generation-progress.js';
import {generationInputDigest} from '../domain/migration-generation-binding.js';
import {randomUUID} from 'node:crypto';

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
    const project=await this.projects.get(id);
    const active=this.progress.get(id);
    const value=active??project.generationAttempts?.at(-1)?.progress;if(!value)return null;
    const snapshot=structuredClone(value);
    if(!active&&snapshot.status==='RUNNING')snapshot.status='INTERRUPTED';
    if(snapshot.status==='RUNNING'){
      const current=snapshot.steps.at(-1);if(current)current.elapsedMs=Date.now()-Date.parse(current.startedAt);
      snapshot.elapsedMs=snapshot.steps.reduce((sum,step)=>sum+step.elapsedMs,0);
    }
    return snapshot;
  }

  async generate(id: string, input: unknown) {
    return this.projects.runExclusive(id, async () => {
      const parsed = z.strictObject({
        baseAssetId: z.string().min(1),
        acknowledgePartialAnalysis: z.boolean().optional(),
        mode:z.enum(['resume','restart']).default('resume'),
      }).parse(input);
      const project = await this.projects.get(id);
      let state:MigrationGenerationProgress={status:'RUNNING',startedAt:new Date().toISOString(),elapsedMs:0,steps:[]};
      let attempt:MigrationGenerationAttempt|undefined;
      const save=async()=>{if(attempt)await this.projects.save(project)};
      const phase=async(phase:GenerationPhase)=>{
        const previous=state.steps.at(-1);if(previous&&!previous.finishedAt){previous.elapsedMs=Date.now()-Date.parse(previous.startedAt);previous.finishedAt=new Date().toISOString();previous.status='COMPLETED';}
        state.steps.push({phase,startedAt:new Date().toISOString(),elapsedMs:0,status:'RUNNING'});
        await save();
      };
      await phase('PREPARING');
      try{
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
      const inputDigest=generationInputDigest(project,this.supplements.digest(supplementRecord));
      const previous=project.generationAttempts?.at(-1);
      if(parsed.mode==='resume'&&previous){
        if(previous.progress.status==='COMPLETED'&&project.candidate?.assetId===previous.candidate?.assetId){
          if(previous.committedInputDigest!==inputDigest)return conflict('当前方案或事实已变化，请重新生成；已完成检查点不能用于新方案');
          return project;
        }
        if(previous.inputDigest!==inputDigest)return conflict('源工程、材料、工具选择或已确认方案已变化，请重新生成；旧检查点不会复用');
        if(previous.progress.failure&&!previous.progress.failure.recoverable)return conflict(previous.progress.failure.message);
        attempt=previous;
        state=attempt.progress;
        const interrupted=state.status==='RUNNING'||state.status==='INTERRUPTED';
        if(interrupted){
          const last=state.steps.at(-1);if(last&&!last.finishedAt){last.finishedAt=new Date().toISOString();last.status='FAILED';}
          (attempt.failures??=[]).push({recordedAt:new Date().toISOString(),failure:{phase:last?.phase??'PREPARING',code:'PROCESS_INTERRUPTED',
            message:'上次执行中断，已完成阶段保留；恢复未完成阶段',recoverable:true}});
        }
        state.status='RUNNING';delete state.failure;delete state.finishedAt;
        this.progress.set(id,state);
        await phase('PREPARING');
      }else{
        attempt={attemptId:`generation-${randomUUID()}`,inputDigest,baseAssetId:currentAsset.assetId,proposalId:plan.reuseProposal!.proposalId,
          version:`2.0.0-migration.${(project.generationAttempts?.length??project.candidateHistory?.length??0)+1}`,progress:state};
        (project.generationAttempts??=[]).push(attempt);
        await save();
      }
      const archive = await this.skills.readArchive(project.source.assetId);
      const version = attempt.version;
      for (const supplement of supplementRecord.items) {
        for (const [name, content] of Object.entries(supplement.files ?? {})) archive[name] = Buffer.from(content, "base64");
      }
      const decisions = project.decisions!.filter(decision => decision.baseAssetId === currentAsset.assetId);
      if(!attempt.candidate){
      if(!attempt.delivery){
        await phase('GENERATING');
        attempt.delivery=await this.implementations.generate(archive, generationInspection, decisions, project.source, plan);
        await save();
      }
      const delivery=attempt.delivery;
      await phase('PACKAGING');
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
        if (generated.files[dependencyPath])throw new MigrationGenerationError({phase:'PACKAGING',code:'RESERVED_PATH_CONFLICT',
          message:'生成工程占用了运行依赖声明路径，请调整产物后重新生成',recoverable:false});
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

      attempt.candidate = await this.skills.uploadZip(Buffer.from(zipSync(generated.files)), { version });
      attempt.generations=generated.generations;attempt.diff=generated.diff;attempt.generationStats=delivery.generationStats;
      delete attempt.delivery;
      await save();
      }
      const candidate=attempt.candidate;
      if(project.generationAttempts?.some(previous=>previous!==attempt&&previous.proposalId===attempt!.proposalId
        &&previous.candidate?.artifactSha256===candidate.artifactSha256
        &&['DESIGN_NOT_IMPLEMENTED','UNCHANGED_REJECTED_ARTIFACT'].includes(previous.progress.failure?.code??'')))
        throw new MigrationGenerationError({phase:'PLAN_REVIEW',code:'UNCHANGED_REJECTED_ARTIFACT',
          message:'生成产物与同一方案下已被否决的候选完全相同，请修改产物或方案；不会重复审查覆盖原结论',recoverable:false});
      // Always verify the full immutable archive, including code and resources, before reusing receipts.
      const candidateFiles=await this.skills.readArchive(candidate.assetId);
      const candidateInspection = await this.candidateInspection.inspect({
        candidate,
        files: candidateFiles,
        inspection: generationInspection,
        decisions: project.decisions!,
        baseAssetId: currentAsset.assetId,
        generations: attempt.generations??[],
        reuseProposal:plan.reuseProposal??undefined,
        onPhase:phase,
        sourceSkillFile:project.source.skillFile,
        checkpoint:attempt.inspectionCheckpoint,
        saveCheckpoint:async checkpoint=>{attempt!.inspectionCheckpoint=checkpoint;await save()},
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
      project.portableGenerations = attempt.generations;
      project.generationStats = attempt.generationStats;
      project.portableGenerationDiff = attempt.diff;
      (project.candidateHistory ??= []).push({
        asset: candidate,
        notes: project.candidateNotes,
        recordedAt: new Date().toISOString(),
        kind: "migration",
      });
      state.status='COMPLETED';
      attempt.committedInputDigest=generationInputDigest(project,this.supplements.digest(supplementRecord));
      await save();
      return project;
      }catch(error){
        state.status='FAILED';
        const failedPhase=state.steps.at(-1)?.phase??'PREPARING';
        state.failure=error instanceof MigrationGenerationError?error.failure:{phase:failedPhase,code:'STAGE_EXECUTION_FAILED',
          message:`${generationPhaseLabels[failedPhase]}未完成，已保存完成阶段；可恢复后重试`,recoverable:true};
        if(attempt)(attempt.failures??=[]).push({recordedAt:new Date().toISOString(),failure:structuredClone(state.failure)});
        if(attempt)throw new MigrationGenerationError(state.failure);
        throw error;
      }
      finally{
        state.finishedAt=new Date().toISOString();
        const last=state.steps.at(-1);if(last&&!last.finishedAt){last.finishedAt=state.finishedAt;last.elapsedMs=Date.parse(state.finishedAt)-Date.parse(last.startedAt);last.status=state.status==='FAILED'?'FAILED':'COMPLETED';}
        state.elapsedMs=state.steps.reduce((sum,step)=>sum+step.elapsedMs,0);
        try{await save()}finally{this.progress.delete(id);}
      }
    });
  }

}
