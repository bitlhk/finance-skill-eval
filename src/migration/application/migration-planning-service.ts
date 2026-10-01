import { z } from 'zod';
import { runtimeBuildRequirements } from '../domain/migration-harness.js';
import { buildMigrationPlan,recommendLanguage,type ToolDecision } from '../domain/migration-model.js';
import type { MigrationHarnessSerializer } from './migration-harness-serializer.js';
import type { MigrationProjectStore } from './migration-project-store.js';
import { migrationConflict as conflict } from './migration-errors.js';
import {runtimeLauncherBindingSchema} from '../../shared/contracts/environment.js';

/** Records migration choices and derives the plan and Runtime requirements from inspection evidence. */
export class MigrationPlanningService {
  constructor(
    private readonly projects:MigrationProjectStore,
    private readonly harnessSerializer:MigrationHarnessSerializer,
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
    return buildMigrationPlan(value.inspection,value.decisions??[],asset.assetId);
  }

  async runtimeRequirements(id:string,runtimeType='openjiuwen') {
    const value=await this.projects.get(id);
    const inspection=value.sourceInspection??value.inspection;
    if(!inspection)return conflict('请先完成源码诊断');
    return runtimeBuildRequirements(inspection,{runtimeType})
      ??{schemaVersion:'finance.runtime-build-requirements.v1',status:'NOT_REQUIRED',requiredCapabilities:[]};
  }

  async runtimeRequirementsYaml(id:string,runtimeType='openjiuwen') {
    const value=await this.projects.get(id);
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
      await this.projects.save(value);
      return delivery;
    });
  }
}
