import { z } from 'zod';
import { buildMigrationPlan,recommendLanguage,type ToolDecision } from '../domain/migration-model.js';
import type { MigrationHarnessSerializer } from './migration-harness-serializer.js';
import type { MigrationProjectStore } from './migration-project-store.js';
import { migrationConflict as conflict } from './migration-errors.js';
import {runtimeLauncherBindingSchema} from '../../shared/contracts/environment.js';
import { currentRuntimeRequirements } from '../domain/migration-runtime-requirements.js';
import { stringify } from 'yaml';
import {migrationRuntimeCapabilities,type MigrationEnvironmentRepository} from './migration-environment-repository.js';
import {runtimeReuseIssues} from '../domain/migration-runtime-reuse.js';
import {canonicalSha256} from '../../shared/json-canonicalization.js';
import {randomUUID} from 'node:crypto';
import {currentReuseProposal,projectMigrationPlan,reuseDesignSchema,reuseDesignIssues,reuseInputDigest} from '../domain/migration-reuse-design.js';
import type {MigrationReusePlanner} from './migration-reuse-planner.js';
import type {MigrationSkillRepository} from './migration-skill-repository.js';
import type {MigrationSupplementRepository} from './migration-supplement-repository.js';
import {portableDeliveryContract} from '../domain/migration-delivery-contract.js';
import type {ReusePlannerTelemetry} from '../domain/migration-reuse-telemetry.js';
import {reuseExecutionContract} from '../domain/migration-reuse-execution-contract.js';

/** Records migration choices and derives the plan and Runtime requirements from inspection evidence. */
export class MigrationPlanningService {
  constructor(
    private readonly projects:MigrationProjectStore,
    private readonly harnessSerializer:MigrationHarnessSerializer,
    private readonly environments?:MigrationEnvironmentRepository,
    private readonly reusePlanner?:MigrationReusePlanner,
    private readonly skills?:MigrationSkillRepository,
    private readonly supplements?:MigrationSupplementRepository,
  ) {}

  async decide(id:string,toolId:string,input:unknown) {
    return this.projects.runExclusive(id,async()=>{
      const parsed=z.strictObject({
        form:z.enum(['MCP','SCRIPT']),
        language:z.string().min(1).max(40).optional(),
        reason:z.string().min(1).max(1000).optional(),
        baseAssetId:z.string().min(1),
      }).parse(input);
      const value=await this.projects.get(id);
      const asset=value.candidate??value.source;
      if(parsed.baseAssetId!==asset.assetId)return conflict('资产已变化，请刷新检查结果后重新确认');
      if(!value.inspection||value.inspection.assetId!==asset.assetId)return conflict('请先检查当前资产');
      const tool=value.inspection.tools.find(item=>item.toolId===toolId);
      if(!tool)return conflict('当前检查结果中不存在这个 Tool');
      const decision:ToolDecision={
        toolId,
        form:parsed.form,
        language:parsed.language??recommendLanguage(parsed.form,tool.language),
        reason:parsed.reason??(parsed.form==='MCP'?'迁移到本 Skill 的共享 MCP 服务':'迁移为独立脚本 Tool'),
        baseAssetId:parsed.baseAssetId,
        decidedAt:new Date().toISOString(),
      };
      value.decisions=[...(value.decisions??[]).filter(item=>!(item.toolId===toolId&&item.baseAssetId===parsed.baseAssetId)),decision];
      await this.projects.save(value);
      return decision;
    });
  }

  async plan(id:string) {
    const value=await this.projects.get(id);
    const asset=value.candidate??value.source;
    if(!value.inspection||value.inspection.assetId!==asset.assetId)return conflict('请先检查当前资产');
    return projectMigrationPlan(value);
  }

  async propose(id:string,input:unknown={}){
    const {clarification}=z.strictObject({clarification:z.string().trim().min(1).max(4000).optional()}).parse(input??{});
    return this.projects.runExclusive(id,async()=>{
      const project=await this.projects.get(id);
      if(project.improvementTasks?.some(task=>['RUNNING','WAITING_BUILDER','WAITING_CONFIGURATION'].includes(task.status)))return conflict('改进任务进行中，不能替换已确认方案');
      if(project.reuseAcceptanceResults?.some(task=>task.status==='RUNNING')||project.generationAttempts?.some(task=>task.progress.status==='RUNNING'))return conflict('生成或复用验收进行中，不能替换迁移方案');
      const inspection=project.sourceInspection??project.inspection;
      if(!inspection||inspection.assetDigest!==project.source.artifactSha256)return conflict('请先分析源工程');
      const decisions=(project.decisions??[]).filter(item=>item.baseAssetId===(project.candidate??project.source).assetId)
        .map(item=>({...item,baseAssetId:inspection.assetId}));
      const toolPlan=buildMigrationPlan(inspection,decisions,inspection.assetId);
      if(!toolPlan.generationAllowed)return conflict('请先完善诊断契约并保存工具选择');
      if(!this.reusePlanner||!this.skills)return conflict('迁移方案模型不可用');
      const archive=await this.skills.readArchive(project.source.assetId);
      const supplementRecord=await this.supplements?.get(id);
      if(supplementRecord&&inspection.dependencyAnalysis?.materialsDigest!==this.supplements!.digest(supplementRecord))return conflict('补充材料已变化，请重新分析源工程');
      for(const item of supplementRecord?.items??[])
        for(const [name,bytes] of Object.entries(item.files??{}))archive[name]=Buffer.from(bytes,'base64');
      const sourceFiles:Record<string,string>={};
      for(const [name,bytes] of Object.entries(archive)){try{sourceFiles[name]=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{}}
      const output=await this.reusePlanner({mode:'PROPOSE',sourceFiles,inspection,toolPlan,
        deliveryContract:portableDeliveryContract(inspection,decisions,project.source.skillFile),executionContract:reuseExecutionContract,
        ...(clarification?{clarification}:{})}) as {status?:string;design?:unknown;reason?:string;telemetry?:ReusePlannerTelemetry};
      if(output?.status!=='PROPOSED')return conflict(`迁移方案无法确认：${output?.reason??'模型未提供方案'}`);
      const parsed=reuseDesignSchema.safeParse(output.design);
      if(!parsed.success)return conflict('迁移方案结构不完整，请重新生成');
      const issues=reuseDesignIssues(parsed.data,inspection,sourceFiles);
      if(issues.length)return conflict(issues.join('；'));
      const previous=project.reuseProposal;
      if(previous)project.reuseProposalHistory=[...(project.reuseProposalHistory??[]),structuredClone(previous)];
      project.reuseProposal={proposalId:`reuse-${randomUUID()}`,sourceDigest:project.source.artifactSha256,
        inputDigest:reuseInputDigest(inspection,decisions,project.source.artifactSha256),createdAt:new Date().toISOString(),design:parsed.data,
        ...(previous?{previousProposalId:previous.proposalId,previousDesign:structuredClone(previous.design)}:{}),
        ...(clarification?{clarification}:{}),...(output.telemetry?{telemetry:output.telemetry}:{})};
      await this.projects.save(project);
      return project.reuseProposal;
    });
  }

  async approve(id:string,input:unknown){
    const parsed=z.strictObject({proposalId:z.string().min(1),inputDigest:z.string().min(1)}).parse(input);
    return this.projects.runExclusive(id,async()=>{
      const project=await this.projects.get(id),proposal=currentReuseProposal(project);
      if(project.improvementTasks?.some(task=>['RUNNING','WAITING_BUILDER','WAITING_CONFIGURATION'].includes(task.status)))return conflict('改进任务进行中，不能替换已确认方案');
      if(project.reuseAcceptanceResults?.some(task=>task.status==='RUNNING')||project.generationAttempts?.some(task=>task.progress.status==='RUNNING'))return conflict('生成或复用验收进行中，不能替换迁移方案');
      if(!proposal||proposal.proposalId!==parsed.proposalId||proposal.inputDigest!==parsed.inputDigest)return conflict('源码、诊断或工具选择已变化，请重新生成迁移方案');
      const supplements=await this.supplements?.get(id);
      if(supplements&&(project.sourceInspection??project.inspection)?.dependencyAnalysis?.materialsDigest!==this.supplements!.digest(supplements))return conflict('补充材料已变化，请重新分析源工程');
      if(proposal.design.unresolvedQuestions.length)return conflict(`方案仍有待确认事项：${proposal.design.unresolvedQuestions.join('；')}`);
      proposal.approvedAt=new Date().toISOString();
      project.reuseProposal=proposal;
      await this.projects.save(project);
      return proposal;
    });
  }

  async runtimeRequirements(id:string,runtimeType='openjiuwen') {
    const value=await this.projects.get(id);
    if(!value.sourceInspection&&!value.inspection)return conflict('请先完成源码诊断');
    return currentRuntimeRequirements(value,runtimeType)
      ??{schemaVersion:'finance.runtime-build-requirements.v1',status:'NOT_REQUIRED',requiredCapabilities:[]};
  }

  async runtimeRequirementsYaml(id:string,runtimeType='openjiuwen') {
    const value=await this.projects.get(id);
    const activeRequirements=currentRuntimeRequirements(value,runtimeType);
    if(activeRequirements&&'requirementsDigest' in activeRequirements)return stringify(activeRequirements);
    const current=value.runtimeRebuilds?.filter(item=>item.candidateDigest===value.candidate?.artifactSha256).at(-1);
    if(current)return stringify(current.requirements);
    const inspection=value.sourceInspection??value.inspection;
    if(!inspection)return conflict('请先完成源码诊断');
    const yaml=this.harnessSerializer.serialize(inspection,runtimeType);
    if(!yaml)return conflict('当前迁移没有 Runtime Harness 改造需求');
    return yaml;
  }

  async bindRuntimeDelivery(id:string,input:unknown) {
    return this.projects.runExclusive(id,async()=>{
      const value=await this.projects.get(id);
      const delivery=runtimeLauncherBindingSchema.parse(input);
      value.runtimeDeliveries={...value.runtimeDeliveries,
        ...(value.runtimeDelivery?{[value.runtimeDelivery.environmentId]:value.runtimeDelivery}:{}),
        [delivery.environmentId]:delivery};
      value.runtimeDelivery=delivery;
      delete value.runtimeReuse;
      await this.projects.save(value);
      return delivery;
    });
  }

  async reuseRuntime(id:string,input:unknown){
    const {environmentId}=z.strictObject({environmentId:z.string().min(1)}).parse(input);
    return this.projects.runExclusive(id,async()=>{
      const project=await this.projects.get(id);
      if(project.improvementTasks?.some(task=>['RUNNING','WAITING_BUILDER','WAITING_CONFIGURATION'].includes(task.status)))return conflict('改进任务进行中，请在任务内继续处理 Runtime');
      const requirements=currentRuntimeRequirements(project);
      if(!requirements||!('requirementsDigest' in requirements))return conflict('请先结合所选 Runtime 完善能力诊断');
      const {launcher,capabilities}=await migrationRuntimeCapabilities(this.environments,environmentId);
      const issues=runtimeReuseIssues(requirements,capabilities);
      if(issues.length)return conflict(`现有 Runtime 尚不能确认满足需求：${issues.join('；')}。请补充诊断或交由 Builder 适配`);
      project.runtimeReuse={environmentId,launcherEnvironmentId:launcher.environmentId,environmentUpdatedAt:launcher.updatedAt,
        requirementsDigest:requirements.requirementsDigest,capabilitiesDigest:canonicalSha256(capabilities),checkedAt:new Date().toISOString()};
      delete project.runtimeDelivery;
      await this.projects.save(project);
      return project.runtimeReuse;
    });
  }
}
