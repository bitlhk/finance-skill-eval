import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { KeyedQueue } from '../shared/keyed-queue.js';
import { z } from 'zod';
import { zipSync, strToU8 } from 'fflate';
import { fingerprint, type EvalPack } from '../contracts.js';
import { listJsonFiles, readJson, writeJsonAtomic } from './file-store.js';
import type { SkillStore, SkillAssetRecord } from './skill-store.js';
import type { EvaluationRunManager } from './run-manager.js';
import type { EvaluationJobStore } from './job-store.js';
import type { EvalPackCatalog } from './catalog.js';
import { runConfigurationSchema, manualPreparationSchema } from './contracts.js';
import type { PreparationStore } from './preparation-store.js';
import type { OptimizationManager } from './optimization-manager.js';
import { configuredModelRole } from './config.js';
import { MigrationDiagnostics } from './migration-diagnostics.js';
import { generateCandidateFiles, versionedMethod, regenerationArchive } from './migration-candidate.js';
import type { EnvironmentStore } from './environment-store.js';
import { MigrationTargetRuns, nativeTarget } from './migration-target.js';
import { inspectProject } from './tool-inspector.js';
import { buildMigrationPlan,type ProjectInspection,type TechnicalValidation,type ToolDecision } from './migration-model.js';
import { generatePortableCandidate,type PortableDiff,type PortableGeneration } from './portable-candidate.js';
import { TechnicalValidationService } from './technical-validation.js';

const createSchema = z.strictObject({sourceAssetId:z.string().min(1), name:z.string().min(1).max(120)});
const candidateSchema = z.strictObject({assetId:z.string().min(1), notes:z.string().min(1).max(8000)});
const draftSchema = z.strictObject({
  source:z.string().min(1).max(128000), notes:z.string().min(1).max(8000),
  baseAssetId:z.string().min(1),
  autoVersion:z.boolean().optional(),
});
const planSchema = z.strictObject({
  pair:z.enum(['AB','BC','AC']), configuration:runConfigurationSchema,
  dataSnapshot:z.string().min(1).max(300), permissionBasis:z.string().min(1).max(1000),
  sourceProjectRef:z.string().min(1).max(1000), dependencyLockRef:z.string().min(1).max(1000),
});
type Migration = {
  schemaVersion:'finance.skill-migration.v0.1'|'finance.skill-migration.v2'; id:string; name:string; createdAt:string;
  legacySourceProjectId?:string;
  source:SkillAssetRecord; candidate:SkillAssetRecord|null; candidateNotes:string;
  candidateHistory?:Array<{asset:SkillAssetRecord;notes:string;recordedAt:string;kind?:'migration'|'optimization'}>;
  suiteIds?:string[];
  optimizations?:Array<{optimizationId:string;sourceJobId:string;baseAssetId:string;candidateDigest:string}>;
  runs:Array<{jobId:string; pair:'AB'|'BC'|'AC'; candidateDigest:string; comparisonFingerprint:string; packFingerprint:string;
    declaredPlan?:z.infer<typeof planSchema>;suiteSnapshot?:EvalPack}>;
  assessment:'NOT_VALIDATED';
  targetRuns?:string[];
  simulationProfile?:string;
  reviews?:Array<{candidateDigest:string;decision:'ACCEPTED'|'NEEDS_CHANGES';notes:string;recordedAt:string;source:'PRIVATE_ADMIN_RECORDED'}>;
  generation?:{candidateDigest:string;target:{runtime:string;environmentId?:string;intent:string};
    diff:Array<{path:string;operation:string;before:string;after:string}>;generatedAt:string};
  inspection?:ProjectInspection;
  decisions?:ToolDecision[];
  portableGenerations?:PortableGeneration[];
  portableGenerationDiff?:PortableDiff[];
  technicalValidations?:TechnicalValidation[];
};
const conflict = (message:string):never => {throw Object.assign(new Error(message),{statusCode:409});};

/** Separate migration snapshots from optimization jobs. No uploaded code is executed here. */
export class MigrationStore {
  private readonly mutations = new KeyedQueue();
  constructor(private root:string, private skills:SkillStore, private runs:EvaluationRunManager,
    private jobs:EvaluationJobStore, private catalog:EvalPackCatalog, private preparations?:PreparationStore,
    private optimizers?:OptimizationManager, private diagnostics?:MigrationDiagnostics, private environments?:EnvironmentStore) {}
  async target(){try{return {available:true,target:await nativeTarget()};}catch{return {available:false,message:'目标 Host 未就绪或模型连接不可用，请联系维护者。'};}}
  async verifyTarget(id:string,input:unknown){return this.serial(id,async()=>{
    const p=z.strictObject({baseAssetId:z.string()}).parse(input),value=await this.get(id);
    if(!value.candidate||p.baseAssetId!==value.candidate.assetId)return conflict('候选已变化，请刷新后验证');
    if(!value.simulationProfile||value.generation?.candidateDigest!==value.candidate.artifactSha256)return conflict('请先审阅映射并生成当前候选；修改后需重新审阅');
    const runner=new MigrationTargetRuns(this.root,this.skills);
    for(const runId of value.targetRuns??[])if((await runner.get(runId)).status==='RUNNING')return conflict('当前项目已有验证正在运行');
    const run=await runner.start(value.candidate,value.simulationProfile);(value.targetRuns??=[]).push(run.id);await writeJsonAtomic(this.file(id),value);return run;
  });}
  private file(id:string) {
    if (!/^migration-[a-f0-9-]+$/.test(id)) throw Object.assign(new Error('Invalid migration id'),{statusCode:400});
    return path.join(this.root,'migrations',id+'.json');
  }
  private serial<T>(id:string, fn:()=>Promise<T>):Promise<T> {
    return this.mutations.run(id, fn);
  }
  async list() {return Promise.all((await listJsonFiles(path.join(this.root,'migrations'))).map(f=>readJson<Migration>(f)));}
  async get(id:string):Promise<Migration> {return readJson<Migration>(this.file(id));}
  async create(input:unknown) {
    const value=await this.serial("create",async()=>{
    const p=createSchema.parse(input), source=await this.skills.get(p.sourceAssetId);
    if (!source) return conflict('Source Skill unavailable');
    const existing=(await this.list()).find(item=>item.source.artifactSha256===source.artifactSha256&&item.name===p.name);
    if(existing)return existing;
    const value:Migration={schemaVersion:'finance.skill-migration.v2',id:'migration-'+randomUUID(),name:p.name,
      createdAt:new Date().toISOString(),source,candidate:null,candidateNotes:'',runs:[],assessment:'NOT_VALIDATED'};
    await writeJsonAtomic(this.file(value.id),value); return value;
    });
    await this.diagnostics?.diagnose(value.source).catch(()=>undefined);return value;
  }
  async upgrade(id:string){
    const legacy=await this.get(id),asset=legacy.candidate??legacy.source;
    if(legacy.schemaVersion==='finance.skill-migration.v2')return legacy;
    const upgraded=await this.create({sourceAssetId:asset.assetId,name:`${legacy.name} 2.0`});
    return this.serial(upgraded.id,async()=>{
      const current=await this.get(upgraded.id);
      if(current.legacySourceProjectId!==legacy.id){current.legacySourceProjectId=legacy.id;await writeJsonAtomic(this.file(current.id),current);}
      return current;
    });
  }
  async diagnose(id:string,retry=false){const value=await this.get(id);
    if(!this.diagnostics)return conflict('Diagnostic service unavailable');
    return this.diagnostics.diagnose(value.source,retry);
  }
  async inspect(id:string){return this.serial(id,async()=>{
    const value=await this.get(id),asset=value.candidate??value.source,archive=await this.skills.readArchive(asset.assetId);
    const files:Record<string,string>={};
    for(const [name,bytes] of Object.entries(archive))try{files[name]=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{}
    const diagnosis=this.diagnostics?await this.diagnostics.diagnose(asset).catch(()=>null):null;
    value.inspection=inspectProject({assetId:asset.assetId,assetDigest:asset.artifactSha256,files,skillFile:asset.skillFile,diagnosis});
    value.decisions=(value.decisions??[]).filter(decision=>decision.baseAssetId===asset.assetId&&value.inspection!.tools.some(tool=>tool.toolId===decision.toolId));
    await writeJsonAtomic(this.file(id),value);return value.inspection;
  });}
  async inspection(id:string){const value=await this.get(id),asset=value.candidate??value.source;
    if(!value.inspection||value.inspection.assetId!==asset.assetId)return this.inspect(id);return value.inspection;
  }
  async decide(id:string,toolId:string,input:unknown){return this.serial(id,async()=>{
    const p=z.strictObject({action:z.enum(['MIGRATE_TO_MCP','MIGRATE_TO_SCRIPT']),targetLanguage:z.string().min(1).max(40).optional(),reason:z.string().min(1).max(1000).optional(),baseAssetId:z.string().min(1)}).parse(input);
    const value=await this.get(id),asset=value.candidate??value.source;
    if(p.baseAssetId!==asset.assetId)return conflict('资产已变化，请刷新检查结果后重新确认');
    if(!value.inspection||value.inspection.assetId!==asset.assetId)return conflict('请先检查当前资产');
    const tool=value.inspection.tools.find(item=>item.toolId===toolId);if(!tool)return conflict('当前检查结果中不存在这个 Tool');
    const decision:ToolDecision={toolId,action:p.action,...(p.targetLanguage?{targetLanguage:p.targetLanguage}:{}),reason:p.reason??(p.action==='MIGRATE_TO_MCP'?'迁移到本 Skill 的共享 MCP 服务':'迁移为独立 Python 脚本'),baseAssetId:p.baseAssetId,decidedAt:new Date().toISOString()};
    value.decisions=[...(value.decisions??[]).filter(item=>!(item.toolId===toolId&&item.baseAssetId===p.baseAssetId)),decision];
    await writeJsonAtomic(this.file(id),value);return decision;
  });}
  async plan(id:string){const value=await this.get(id),asset=value.candidate??value.source;
    if(!value.inspection||value.inspection.assetId!==asset.assetId)return conflict('请先检查当前资产');
    return buildMigrationPlan(value.inspection,value.decisions??[],asset.assetId);
  }
  private async generatePortable(id:string,input:unknown){return this.serial(id,async()=>{
    const p=z.strictObject({baseAssetId:z.string().min(1)}).parse(input),value=await this.get(id),asset=value.candidate??value.source;
    if(p.baseAssetId!==asset.assetId)return conflict('资产已变化，请刷新后重新生成');
    if(!value.inspection||value.inspection.assetId!==asset.assetId)return conflict('请先检查当前资产');
    const plan=buildMigrationPlan(value.inspection,value.decisions??[],asset.assetId);if(!plan.generationAllowed)return conflict('当前逐 Tool 决策尚不能生成候选');
    const archive=await this.skills.readArchive(asset.assetId),version=`2.0.0-migration.${(value.candidateHistory?.length??0)+1}`;
    for(const [name,bytes] of Object.entries(archive).filter(([name])=>name.startsWith('migration-generated/v2/'))){
      const expected=value.portableGenerationDiff?.find(item=>item.path===name)?.after;
      if(expected===undefined||Buffer.from(bytes).toString('utf8')!==expected)return conflict('生成文件已被人工修改；为避免覆盖工程改动，请将其作为新实现重新导入和检查');
      delete archive[name];
    }
    const generated=generatePortableCandidate({archive,base:asset,inspection:value.inspection,decisions:value.decisions!.filter(d=>d.baseAssetId===asset.assetId),version});
    const candidate=await this.skills.uploadZip(Buffer.from(zipSync(generated.files)));
    value.candidate=candidate;value.candidateNotes='按逐 Tool 决策生成 2.0 候选；原始资产保持不变。';value.portableGenerations=generated.generations;value.portableGenerationDiff=generated.diff;
    (value.candidateHistory??=[]).push({asset:candidate,notes:value.candidateNotes,recordedAt:new Date().toISOString(),kind:'migration'});
    await writeJsonAtomic(this.file(id),value);return value;
  });}
  async validateTechnical(id:string,input:unknown,signal?:AbortSignal){return this.serial(id,async()=>{
    const p=z.strictObject({toolId:z.string().min(1),baseAssetId:z.string().min(1),request:z.unknown().optional(),endpoint:z.string().url().optional(),arguments:z.record(z.unknown()).optional()}).parse(input);
    const value=await this.get(id),asset=value.candidate??value.source;if(p.baseAssetId!==asset.assetId)return conflict('资产已变化，请刷新后重新验证');
    const inspection=value.inspection;if(!inspection)return conflict('请先完成 Tool 检查');
    const tool=inspection.tools.find(item=>item.toolId===p.toolId);if(!tool)return conflict('当前检查结果中不存在这个 Tool');
    const generated=value.portableGenerations?.find(item=>item.toolId===tool.toolId);if(generated&&!generated.readyForValidation)return conflict('生成候选仍有待办，不能标记技术验证通过');
    const service=new TechnicalValidationService(),archive=await this.skills.readArchive(asset.assetId);
    const result=tool.kind==='MCP'?await service.validateMcp({asset,tool,endpoint:p.endpoint??'',arguments:p.arguments,signal}):await service.validateScript({asset,archive,tool,request:p.request,signal});
    (value.technicalValidations??=[]).push(result);await writeJsonAtomic(this.file(id),value);return result;
  });}
  async technicalValidations(id:string){return (await this.get(id)).technicalValidations??[];}
  private currentTechnicalState(value:Migration){
    const asset=value.candidate??value.source,inspection=value.inspection;
    if(!inspection)return {ready:false,reasons:['请先完成 Tool 检查']};
    const latest=new Map<string,TechnicalValidation>();
    for(const result of value.technicalValidations??[])if(result.assetDigest===asset.artifactSha256)latest.set(result.toolId,result);
    const reasons=inspection.tools.flatMap(tool=>latest.get(tool.toolId)?.status==='PASSED'?[]:[`${tool.name} 尚未通过当前资产的技术验证`]);
    return {ready:reasons.length===0,reasons};
  }
  async validateOpenJiuwen(id:string,input:unknown){
    const value=await this.get(id),state=this.currentTechnicalState(value);
    if(value.inspection?.skill.status!=='COMPLIANT')return conflict('OpenJiuwen 验证被阻止：当前 Skill 尚未通过企业规范检查');
    if(!state.ready)return conflict(`OpenJiuwen 验证被阻止：${state.reasons.join('；')}`);
    const body=input as {configuration?:{runtime?:{type?:string;environmentId?:string}}};
    if(body?.configuration?.runtime?.type!=='runtime_http')return conflict('OpenJiuwen 验证必须选择已登记的 Runtime HTTP 环境');
    const environmentId=body.configuration.runtime.environmentId;
    const environment=environmentId?await this.environments?.get(environmentId):null;
    if(!environment||environment.type!=='runtime_http'||environment.runtimeType!=='openjiuwen')return conflict('目标必须是已登记的 OpenJiuwen 环境');
    const inspection=value.inspection!,asset=value.candidate??value.source,archive=await this.skills.readArchive(asset.assetId);
    const scripts=inspection.tools.filter(tool=>tool.kind==='SCRIPT'&&tool.entrypoint?.path&&['PYTHON','NODE'].includes(tool.entrypoint.kind))
      .map(tool=>{const entry=tool.entrypoint!.path!.replaceAll('\\','/');let root=entry.split('/').slice(0,-1).join('/'),cursor=root;
        while(true){const prefix=cursor?`${cursor}/`:'';if(archive[`${prefix}pyproject.toml`]||archive[`${prefix}package.json`]){root=cursor;break;}if(!cursor)break;cursor=cursor.split('/').slice(0,-1).join('/');}
        const filePaths=Object.keys(archive).filter(name=>(!root||name.startsWith(`${root}/`))&&/\.(?:py|js|mjs|cjs|json|toml|lock)$/iu.test(name));
        return {name:tool.name,path:entry,kind:tool.entrypoint!.kind as 'PYTHON'|'NODE',filePaths,...(tool.inputSchema?{inputSchema:tool.inputSchema}:{})};});
    const normalized={...(input as Record<string,unknown>),configuration:{...(body.configuration as Record<string,unknown>),runtimeToolBindings:{left:scripts,right:scripts}}};
    return this.validate(id,normalized);
  }
  async openJiuwenValidations(id:string){
    return (await this.report(id)).openJiuwenValidations;
  }
  async generate(id:string,input:unknown){
    if(input&&typeof input==='object'&&'runtime' in input)return this.generateLegacy(id,input);
    return this.generatePortable(id,input);
  }
  private async generateLegacy(id:string,input:unknown){return this.serial(id,async()=>{
    const p=z.strictObject({runtime:z.enum(['openjiuwen']),environmentId:z.string().optional(),
      intent:z.enum(['portable_method_and_adapters','preserve_business_method']),baseAssetId:z.string(),simulationProfile:z.string().optional(),acknowledgeSimulation:z.literal(true).optional()}).parse(input);
    const value=await this.get(id);
    if(p.baseAssetId!==(value.candidate??value.source).assetId)return conflict('候选已变化，请刷新后重新生成');
    if(p.environmentId){const env=await this.environments?.get(p.environmentId);
      if(!env||env.type!=='runtime_http'||env.runtimeType!=='openjiuwen')return conflict('目标必须是已登记的 OpenJiuwen 环境');}
    const base=value.candidate??value.source;
    const originalArchive=await this.skills.readArchive(base.assetId);
    if(value.generation)for(const [name,bytes] of Object.entries(originalArchive).filter(([name])=>name.startsWith('migration-generated/'))){
      const expected=value.generation.diff.find(d=>d.path===name)?.after;
      if(expected===undefined||Buffer.from(bytes).toString()!==expected)return conflict('适配生成文件已修改；为避免覆盖工程改动，请先人工处理冲突');
    }
    const archive=regenerationArchive(originalArchive,base);
    const diagnosis=this.diagnostics?await this.diagnostics.diagnose(base):await this.diagnose(id);
    const version=`0.1.0-migration.${(value.candidateHistory?.length??0)+1}`;
    const target={runtime:p.runtime,...(p.environmentId?{environmentId:p.environmentId}:{}),intent:p.intent};
    if(p.simulationProfile&&!p.acknowledgeSimulation)return conflict('请确认模拟端口、资源映射与业务待确认边界');
    const simulation=p.simulationProfile?{id:p.simulationProfile,target:await nativeTarget()}:undefined;
    const generated=generateCandidateFiles(archive,base,diagnosis,version,target,simulation);
    const candidate=await this.skills.uploadZip(Buffer.from(zipSync(generated.files)));
    // The legacy request shape intentionally enters the 0.1 workflow. Keeping
    // that identity prevents its simulated target evidence from being mistaken
    // for a 2.0 OpenJiuwen validation.
    value.schemaVersion='finance.skill-migration.v0.1';
    value.candidate=candidate;value.candidateNotes='基于当前版本生成声明与薄适配；保留方法修改和资源，等待本版本验证。';
    value.simulationProfile=p.simulationProfile;
    value.generation={candidateDigest:candidate.artifactSha256,target,diff:generated.diff,generatedAt:new Date().toISOString()};
    (value.candidateHistory??=[]).push({asset:candidate,notes:value.candidateNotes,recordedAt:new Date().toISOString(),kind:'migration'});
    await writeJsonAtomic(this.file(id),value);return value;
  });}
  async candidate(id:string,input:unknown) {return this.serial(id,async()=>{
    const p=candidateSchema.parse(input), value=await this.get(id), candidate=await this.skills.get(p.assetId);
    if (!candidate || candidate.artifactSha256===value.source.artifactSha256) return conflict('Import a separate versioned candidate; source remains immutable');
    if (candidate.version===value.source.version) return conflict('Candidate must use a new version');
    value.candidate=candidate; value.candidateNotes=p.notes;
    delete value.inspection;value.decisions=[];delete value.portableGenerations;delete value.portableGenerationDiff;
    (value.candidateHistory??=[]).push({asset:candidate,notes:p.notes,recordedAt:new Date().toISOString()});
    await writeJsonAtomic(this.file(id),value); return value;
  });}
  async draft(id:string,input:unknown) {return this.serial(id,async()=>{
    const p=draftSchema.parse(input), value=await this.get(id), base=value.candidate??value.source;
    if (p.baseAssetId!==base.assetId) return conflict('Candidate changed; reload before editing');
    const files=await this.skills.readArchive(base.assetId);
    files[base.skillFile]=strToU8(p.autoVersion?versionedMethod(p.source,base.skillId,`0.1.0-migration.${(value.candidateHistory?.length??0)+1}`):p.source);
    const candidate=await this.skills.uploadZip(Buffer.from(zipSync(files)));
    if (candidate.version==='0.0.0-upload' || candidate.version===base.version || candidate.version===value.source.version)
      return conflict('Set an explicit new version in Skill metadata before saving');
    if (candidate.skillId!==base.skillId) return conflict('Method edits cannot silently change the Skill identity');
    value.candidate=candidate;value.candidateNotes=p.notes;
    (value.candidateHistory??=[]).push({asset:candidate,notes:p.notes,recordedAt:new Date().toISOString()});
    await writeJsonAtomic(this.file(id),value);return value;
  });}
  async analyze(id:string) {
    const value=await this.get(id), source=await this.skills.readSource(value.source.assetId);
    const files=await this.skills.readFiles((value.candidate??value.source).assetId);
    const archive=await this.skills.readArchive((value.candidate??value.source).assetId);
    const diagnosis=this.diagnostics?await this.diagnostics.diagnose(value.candidate??value.source).catch(()=>null):null;
    return {project:value, source, candidate:value.candidate ? await this.skills.readSource(value.candidate.assetId):null,diagnosis,
      readableFiles:Object.keys(files), inventoryComplete:diagnosis?.status==='COMPLETE',
      fileInventory:Object.entries(archive).map(([name,bytes])=>({name,bytes:bytes.length,
        sha256:createHash('sha256').update(bytes).digest('hex'),
        executableReviewRequired:/\.(py|sh|js|mjs|cjs|exe|jar)$/i.test(name)})),
      unresolved:diagnosis?.findings.filter(f=>f.layer==='UNKNOWN').map(f=>f.dependencyType)??['DIAGNOSIS_NOT_RUN'],
      analysisMode:'STATIC_INVENTORY_NOT_DEPENDENCY_VALIDATION', uploadedScriptsExecuted:false};
  }
  async review(id:string,input:unknown){return this.serial(id,async()=>{
    const p=z.strictObject({baseAssetId:z.string(),decision:z.enum(['ACCEPTED','NEEDS_CHANGES']),notes:z.string().min(1).max(2000)}).parse(input);
    const value=await this.get(id);
    if(!value.candidate||p.baseAssetId!==value.candidate.assetId)return conflict('候选已变化，请对当前版本重新记录专业复核');
    (value.reviews??=[]).push({candidateDigest:value.candidate.artifactSha256,decision:p.decision,notes:p.notes,recordedAt:new Date().toISOString(),source:'PRIVATE_ADMIN_RECORDED'});
    await writeJsonAtomic(this.file(id),value);return value;
  });}
  async createSuite(id:string,input:unknown) {return this.serial(id,async()=>{
    const p=manualPreparationSchema.parse(input),value=await this.get(id);
    if (!this.preparations) return conflict('Preparation store unavailable');
    const suite=await this.preparations.create({skill:value.source,summary:p.summary,cases:p.cases,holdoutCases:p.holdoutCases,source:'manual'});
    (value.suiteIds??=[]).push(suite.preparationId);await writeJsonAtomic(this.file(id),value);return suite;
  });}
  async optimize(id:string,input:unknown) {return this.serial(id,async()=>{
    const p=z.strictObject({jobId:z.string().min(1)}).parse(input),value=await this.get(id);
    if (!this.optimizers || !value.candidate) return conflict('Optimizer or candidate unavailable');
    if(value.generation)return conflict('生成候选需先完成原生迁移验证；当前 Host 适配验收尚未完成，暂不进入表达优化');
    const experiment=value.runs.find(r=>r.jobId===p.jobId);
    if (!experiment || experiment.candidateDigest!==value.candidate.artifactSha256) return conflict('Select an experiment for the current candidate');
    if(value.schemaVersion==='finance.skill-migration.v2'){
      const technical=this.currentTechnicalState(value);if(!technical.ready)return conflict(`请先完成当前 Tool 技术验证：${technical.reasons.join('；')}`);
      const environmentId=experiment.declaredPlan?.configuration.runtime.type==='runtime_http'?experiment.declaredPlan.configuration.runtime.environmentId:null;
      const environment=environmentId?await this.environments?.get(environmentId):null;
      if(!environment||environment.type!=='runtime_http'||environment.runtimeType!=='openjiuwen')return conflict('请先完成当前候选的 OpenJiuwen 评估');
    }
    const job=this.jobs.get(p.jobId),variant=job?.report?.variants.right;
    if (variant?.mode!=='skill_version' || variant.artifactSha256!==value.candidate.artifactSha256) return conflict('Completed right-side candidate evidence required');
    const item=await this.optimizers.create(p.jobId);
    (value.optimizations??=[]).push({optimizationId:item.optimizationId,sourceJobId:p.jobId,baseAssetId:value.candidate.assetId,candidateDigest:value.candidate.artifactSha256});
    await writeJsonAtomic(this.file(id),value);return item;
  });}
  async adoptOptimization(id:string,input:unknown) {return this.serial(id,async()=>{
    const p=z.strictObject({optimizationId:z.string().min(1)}).parse(input),value=await this.get(id);
    const link=value.optimizations?.find(o=>o.optimizationId===p.optimizationId);
    if (!link || !this.optimizers || value.candidate?.assetId!==link.baseAssetId) return conflict('Optimization is unrelated or its base candidate has changed');
    const item=await this.optimizers.get(p.optimizationId);
    if (!item.candidate || !['review','adopted'].includes(item.status)) return conflict('Optimization must finish reevaluation before local adoption');
    await this.skills.readArchive(item.candidate.assetId);
    value.candidate=item.candidate;value.candidateNotes=`Optimization ${item.optimizationId}: ${item.summary}`;
    (value.candidateHistory??=[]).push({asset:item.candidate,notes:value.candidateNotes,recordedAt:new Date().toISOString(),kind:'optimization'});
    // Adoption is a local candidate choice, not migration or business acceptance.
    await writeJsonAtomic(this.file(id),value);return value;
  });}
  async validate(id:string,input:unknown) {return this.serial(id,async()=>{
    const p=planSchema.parse(input), value=await this.get(id), c=value.candidate;
    if (!c || !p.configuration.runtimeBindings) return conflict('Candidate and per-side bindings are required');
    let pack=p.configuration.packId ? this.catalog.get(p.configuration.packId):null;
    if (p.configuration.preparationId) {
      if (!value.suiteIds?.includes(p.configuration.preparationId)) return conflict('Select a frozen suite owned by this migration');
      const preparation=await this.preparations?.get(p.configuration.preparationId);
      if (preparation) pack=this.preparations!.buildPack({preparation,analyzerModel:configuredModelRole('ANALYZER').model,
        executionModel:p.configuration.executionModel!,judgeModel:configuredModelRole('JUDGE').model});
    }
    if (!pack || p.configuration.includeHoldout) return conflict('Select one frozen development suite; holdout is reserved for independent reevaluation');
    const expected=p.pair==='AB' ? [value.source,c] : p.pair==='BC' ? [c,c] : [value.source,c];
    for (const [index,side] of (['left','right'] as const).entries()) {
      const binding=p.configuration.runtimeBindings[side], variant=p.configuration[side==='left'?'leftVariant':'rightVariant'];
      const asset=expected[index]!;
      if (binding.skillAssetId!==asset.assetId || variant?.mode!=='skill_version' || variant.artifactSha256!==asset.artifactSha256
          || variant.skillId!==asset.skillId || variant.version!==asset.version) return conflict('Pair asset binding does not match the frozen source/candidate');
    }
    if (p.pair==='AB' && p.configuration.runtimeBindings.left.environmentId!==p.configuration.runtimeBindings.right.environmentId) return conflict('AB must preserve the original Runtime environment');
    const comparisonFingerprint=fingerprint({pack:pack.packFingerprint, model:p.configuration.executionModel,
      cases:p.configuration.selectedCaseIds, data:p.dataSnapshot, permissions:p.permissionBasis,
      sourceProject:p.sourceProjectRef, lock:p.dependencyLockRef});
    const job=await this.runs.create(p.configuration);
    value.runs.push({jobId:job.jobId,pair:p.pair,candidateDigest:c.artifactSha256,comparisonFingerprint,packFingerprint:pack.packFingerprint,declaredPlan:p,suiteSnapshot:pack});
    await writeJsonAtomic(this.file(id),value);
    return {job,comparisonFingerprint,acceptance:'NOT_VALIDATED',note:'Runs are experiments; declared environment/material references are not native-runtime or authorization attestation.'};
  });}
  async report(id:string) {
    const value=await this.get(id);
    const diagnosis=this.diagnostics?await this.diagnostics.diagnose(value.source):null;
    const targetRunner=new MigrationTargetRuns(this.root,this.skills);
    const targetRuns=await Promise.all((value.targetRuns??[]).map(runId=>targetRunner.get(runId)));
    const current=targetRuns.filter(r=>r.candidateDigest===value.candidate?.artifactSha256).at(-1);
    const currentAsset=value.candidate??value.source;
    const technicalValidations=(value.technicalValidations??[]).map(result=>({...result,current:result.assetDigest===currentAsset.artifactSha256}));
    const migrationPlan=value.inspection?buildMigrationPlan(value.inspection,value.decisions??[],value.inspection.assetId):null;
    const experiments=value.runs.map(r=>{
      const job=this.jobs.get(r.jobId);
      const complete=job?.status==='completed' && !!job.report?.cases.length && job.report.cases.every(c=>(['left','right'] as const).every(side=>{
        const variant=job.configuration[side==='left'?'leftVariant':'rightVariant'];
        return c[side].status==='completed' && variant?.mode==='skill_version' && !!variant.artifactSha256
          && c[side].metadata.skillArtifactSha256===variant.artifactSha256;
      }));
      return {...r,execution:job?.status??'MISSING',report:job?.report??null,evidence:complete?'HTTP_LOADED_DIGEST_CHECKED':'NOT_COMPLETE',
        taskSuccess:'NOT_INDEPENDENTLY_VERIFIED',professionalAcceptance:'NOT_REVIEWED',migrationAcceptance:'NOT_VALIDATED'};
    });
    const openJiuwenValidations=(await Promise.all(experiments.map(async experiment=>{
      const runtime=experiment.declaredPlan?.configuration.runtime;
      const environment=runtime?.type==='runtime_http'?await this.environments?.get(runtime.environmentId):null;
      if(!environment||environment.type!=='runtime_http'||environment.runtimeType!=='openjiuwen')return null;
      return {jobId:experiment.jobId,candidateDigest:experiment.candidateDigest,environmentId:environment.environmentId,
        execution:experiment.execution,evidence:experiment.evidence,current:experiment.candidateDigest===currentAsset.artifactSha256,
        status:experiment.execution==='completed'&&experiment.evidence==='HTTP_LOADED_DIGEST_CHECKED'?'PASSED':experiment.execution==='failed'?'FAILED':['queued','preparing','running','judging'].includes(experiment.execution)?'RUNNING':'NOT_VALIDATED'};
    }))).filter(item=>item!==null);
    const currentOpenJiuwen=openJiuwenValidations.filter(item=>item.current).at(-1);
    const targetExecution=value.schemaVersion==='finance.skill-migration.v2'?(currentOpenJiuwen?.status??'NOT_RUN'):(current?.status??'NOT_RUN');
    return {project:value,diagnosis,inspection:value.inspection??null,decisions:value.decisions??[],migrationPlan,portableGenerationDiff:value.portableGenerationDiff??[],technicalValidations,openJiuwenValidations,targetRuns,professionalReview:value.reviews?.filter(r=>r.candidateDigest===value.candidate?.artifactSha256).at(-1)??null,verification:{originalBaseline:'NOT_RUN',targetExecution,
      candidateChanged:!!value.generation&&value.generation.candidateDigest!==value.candidate?.artifactSha256,
      originalOwner:'原工程负责人',targetOwner:'Harness / Host 接入开发者',
      missingSource:diagnosis?.findings.filter(f=>f.layer==='UNKNOWN').map(f=>({path:f.path,line:f.line,reason:f.reason}))??[],
      targetGaps:value.simulationProfile?['本目标只验证方法在模拟业务端口上的执行，不证明原环境等价或专业结论正确。','原工程、原环境对照与业务口径仍待负责人确认。']:['当前工具尚未接入已支持的目标 Host；请由接入开发者补齐工具实现、Schema 和资源映射',
        '需冻结等价测试数据与可信身份范围；配置声明不等于授权已核验']},
      suites:await Promise.all((value.suiteIds??[]).map(id=>this.preparations?.get(id)??null)),
      optimizations:await Promise.all((value.optimizations??[]).map(async link=>({...link,item:await this.optimizers?.get(link.optimizationId)}))),
      experiments, attribution:'BC compares target execution stacks, including Harness; not a pure Runtime effect.'};
  }
  async exportCandidate(id:string) {
    const value=await this.get(id);
    if (!value.candidate) return conflict('Candidate required');
    const files=await this.skills.readArchive(value.candidate.assetId);
    if (['migration-manifest.json','migration-report.json'].some(name=>name in files)) return conflict('Reserved export metadata path exists in candidate; no file was overwritten');
    const report=await this.report(id);
    for(const [name,bytes] of Object.entries(files)){
      if(/(^|\/)(\.env(?:\..*)?|access-token|id_rsa|id_ed25519)$|\.(pem|key)$/i.test(name)||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"'\n]{8,}["']/i.test(Buffer.from(bytes).toString()))
        return conflict('候选可能包含凭据，请先检查并移除敏感配置；未导出任何文件');
    }
    const technicalReady=this.currentTechnicalState(value).ready;
    const state=value.schemaVersion==='finance.skill-migration.v2'
      ? report.verification.targetExecution==='PASSED'?'OPENJIUWEN_VALIDATED_CANDIDATE':technicalReady?'TECHNICALLY_VALIDATED_DRAFT':'DRAFT_NOT_VALIDATED'
      : report.verification.targetExecution==='PASSED'?'TARGET_VERIFIED_CANDIDATE':'DRAFT_NOT_VALIDATED';
    const manifest={schemaVersion:value.schemaVersion==='finance.skill-migration.v2'?'finance.skill-migration.exchange.v2':'finance.skill-migration.exchange.v0.1',projectId:id,source:value.source,candidate:value.candidate,
      state,builderImport:'NOT_VERIFIED',installationLock:'ASSEMBLER_RESPONSIBILITY',
      executionPolicy:'INERT_ARCHIVE_ONLY_NO_SCRIPT_EXECUTION',dependencies:'NOT_VALIDATED',
      fileDigestAlgorithm:'SHA-256 of original file bytes',
      files:Object.fromEntries(Object.entries(files).map(([name,content])=>[name,createHash('sha256').update(content).digest('hex')]))};
    return Buffer.from(zipSync({...files,'migration-manifest.json':strToU8(JSON.stringify(manifest,null,2)),
      'migration-report.json':strToU8(JSON.stringify({schemaVersion:value.schemaVersion==='finance.skill-migration.v2'?'migration.export-scope.v2':'migration.export-scope.v1',state,
        candidateDigest:value.candidate.artifactSha256,inspection:report.inspection,decisions:report.decisions,migrationPlan:report.migrationPlan,
        technicalValidations:report.technicalValidations.map(v=>({validationId:v.validationId,toolId:v.toolId,assetDigest:v.assetDigest,implementationDigest:v.implementationDigest,casesDigest:v.casesDigest,mode:v.mode,status:v.status,stages:v.stages,current:v.current})),openJiuwenValidations:report.openJiuwenValidations,verification:report.verification,
        changes:(value.portableGenerationDiff??value.generation?.diff??[]).map(d=>({path:d.path,operation:d.operation})),
        targetRuns:report.targetRuns.map(r=>({id:r.id,candidateDigest:r.candidateDigest,status:r.status,
          cases:r.cases.map(c=>({caseId:c.caseId,passed:c.passed}))})),
        professionalAcceptance:report.professionalReview?'ADMIN_RECORDED_NOT_INDEPENDENTLY_VERIFIED':'NOT_REVIEWED',
        professionalReview:report.professionalReview?{decision:report.professionalReview.decision,source:report.professionalReview.source,recordedAt:report.professionalReview.recordedAt}:null,
        originalEquivalence:'NOT_VERIFIED',
        excluded:'No raw model answers, test payloads, connection configuration or complete experiment reports. Review your own method/resource files for private content before sharing.'},null,2))}));
  }
  release():never {return conflict('Release blocked: original native baseline, target Host integration, dependency validation and independent business acceptance remain unverified');}
}
