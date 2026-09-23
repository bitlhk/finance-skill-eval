import { zipSync } from 'fflate';
import { z } from 'zod';
import { generateCandidateFiles, regenerationArchive } from '../../service/migration-candidate.js';
import type { MigrationDiagnostics } from '../../service/migration-diagnostics.js';
import { MigrationTargetRuns, nativeTarget } from '../infrastructure/migration-target.js';
import type { EnvironmentStore } from '../../service/environment-store.js';
import type { SkillStore } from '../../service/skill-store.js';
import type { MigrationProjectRepository } from '../infrastructure/migration-project-repository.js';
import type { MigrationProjectService } from './migration-project-service.js';
import { migrationConflict as conflict } from './migration-errors.js';

/** Compatibility boundary for the deprecated finance.skill-migration.v0.1 workflow. */
export class MigrationLegacyService {
  constructor(
    private readonly root:string,
    private readonly projects:MigrationProjectRepository,
    private readonly projectService:MigrationProjectService,
    private readonly skills:SkillStore,
    private readonly diagnostics?:MigrationDiagnostics,
    private readonly environments?:EnvironmentStore,
  ) {}

  private async migrationEnvironment(environmentId:string) {
    return await this.environments?.get(environmentId)??null;
  }

  async target() {
    try {
      return {available:true,target:await nativeTarget()};
    } catch {
      return {available:false,message:'目标 Host 未就绪或模型连接不可用，请联系维护者。'};
    }
  }

  async verifyTarget(id:string,input:unknown) {
    return this.projects.runExclusive(id,async()=>{
      const parsed=z.strictObject({baseAssetId:z.string()}).parse(input),value=await this.projects.get(id);
      if(!value.candidate||parsed.baseAssetId!==value.candidate.assetId)return conflict('候选已变化，请刷新后验证');
      if(!value.simulationProfile||value.generation?.candidateDigest!==value.candidate.artifactSha256)return conflict('请先审阅映射并生成当前候选；修改后需重新审阅');
      const runner=new MigrationTargetRuns(this.root,this.skills);
      for(const runId of value.targetRuns??[])if((await runner.get(runId)).status==='RUNNING')return conflict('当前项目已有验证正在运行');
      const run=await runner.start(value.candidate,value.simulationProfile);
      (value.targetRuns??=[]).push(run.id);
      await this.projects.save(value);
      return run;
    });
  }

  async generate(id:string,input:unknown) {
    return this.projects.runExclusive(id,async()=>{
      const parsed=z.strictObject({runtime:z.enum(['openjiuwen']),environmentId:z.string().optional(),
        intent:z.enum(['portable_method_and_adapters','preserve_business_method']),baseAssetId:z.string(),simulationProfile:z.string().optional(),acknowledgeSimulation:z.literal(true).optional()}).parse(input);
      const value=await this.projects.get(id);
      if(parsed.baseAssetId!==(value.candidate??value.source).assetId)return conflict('候选已变化，请刷新后重新生成');
      if(parsed.environmentId){
        const environment=await this.migrationEnvironment(parsed.environmentId);
        if(!environment||environment.type!=='runtime_launcher'||environment.runtimeType!=='openjiuwen')return conflict('目标必须是已配置的 OpenJiuwen Runtime Launcher');
      }
      const base=value.candidate??value.source;
      const originalArchive=await this.skills.readArchive(base.assetId);
      if(value.generation)for(const [name,bytes] of Object.entries(originalArchive).filter(([name])=>name.startsWith('migration-generated/'))){
        const expected=value.generation.diff.find(change=>change.path===name)?.after;
        if(expected===undefined||Buffer.from(bytes).toString()!==expected)return conflict('适配生成文件已修改；为避免覆盖工程改动，请先人工处理冲突');
      }
      const archive=regenerationArchive(originalArchive,base);
      const diagnosis=this.diagnostics?await this.diagnostics.diagnose(base):await this.projectService.diagnose(id);
      const version=`0.1.0-migration.${(value.candidateHistory?.length??0)+1}`;
      const target={runtime:parsed.runtime,...(parsed.environmentId?{environmentId:parsed.environmentId}:{}),intent:parsed.intent};
      if(parsed.simulationProfile&&!parsed.acknowledgeSimulation)return conflict('请确认模拟端口、资源映射与业务待确认边界');
      const simulation=parsed.simulationProfile?{id:parsed.simulationProfile,target:await nativeTarget()}:undefined;
      const generated=generateCandidateFiles(archive,base,diagnosis,version,target,simulation);
      const candidate=await this.skills.uploadZip(Buffer.from(zipSync(generated.files)));
      // The legacy request shape intentionally enters the 0.1 workflow. Keeping
      // that identity prevents its simulated target evidence from being mistaken
      // for a 2.0 OpenJiuwen validation.
      value.schemaVersion='finance.skill-migration.v0.1';
      value.candidate=candidate;
      value.candidateNotes='基于当前版本生成声明与薄适配；保留方法修改和资源，等待本版本验证。';
      value.simulationProfile=parsed.simulationProfile;
      value.generation={candidateDigest:candidate.artifactSha256,target,diff:generated.diff,generatedAt:new Date().toISOString()};
      (value.candidateHistory??=[]).push({asset:candidate,notes:value.candidateNotes,recordedAt:new Date().toISOString(),kind:'migration'});
      await this.projects.save(value);
      return value;
    });
  }
}
