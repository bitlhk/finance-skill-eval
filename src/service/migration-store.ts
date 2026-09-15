import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
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
import { buildMigrationPlan,languageOfSourcePaths,recommendLanguage,stableToolId,type MigrationPlan,type ProjectInspection,type TechnicalValidation,type ToolDecision } from './migration-model.js';
import { analyzeWithAgent,contractSample,implementWithAgent,toGeneratedImplementations,toProjectInspection,type MigrationAnalyzer,type MigrationImplementer } from './migration-agent.js';
import { generatePortableCandidate,type PortableDiff,type PortableGeneration } from './portable-candidate.js';
import { baselineBrief,generateSuiteWithAnalyzer,type MigrationSuiteGenerator } from './migration-suite.js';
import { stageEnvelope,staleAgainst } from './stage-envelope.js';
import { TechnicalValidationService } from './technical-validation.js';
import { MigrationCodeGenerator } from './migration-code-generator.js';

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
  /** The A2 product as a stage product: its binding is what says which asset it describes. */
  analysis?:import('./stage-envelope.js').StageEnvelope<ProjectInspection>;
  decisions?:ToolDecision[];
  portableGenerations?:PortableGeneration[];
  portableGenerationDiff?:PortableDiff[];
  technicalValidations?:TechnicalValidation[];
};
const conflict = (message:string):never => {throw Object.assign(new Error(message),{statusCode:409});};
const CODE_FILE=/\.(?:java|py|js|mjs|cjs|ts)$/iu;

/** Separate migration snapshots from optimization jobs. No uploaded code is executed here. */
export class MigrationStore {
  private chain:Promise<unknown> = Promise.resolve();
  constructor(private root:string, private skills:SkillStore, private runs:EvaluationRunManager,
    private jobs:EvaluationJobStore, private catalog:EvalPackCatalog, private preparations?:PreparationStore,
    private optimizers?:OptimizationManager, private diagnostics?:MigrationDiagnostics, private environments?:EnvironmentStore,
    private codeGenerator=new MigrationCodeGenerator(()=>configuredModelRole('MIGRATION')),
    private analyzer:MigrationAnalyzer=(input,)=>analyzeWithAgent(input,{projectRoot:process.env.FINANCE_EVAL_ROOT?.trim()||process.cwd(),
      modelId:process.env.FINANCE_EVAL_AGENT_MODEL_ID?.trim()||'enterprise-model'}),
    private implementer:MigrationImplementer=(input,)=>implementWithAgent(input,{projectRoot:process.env.FINANCE_EVAL_ROOT?.trim()||process.cwd(),
      modelId:process.env.FINANCE_EVAL_AGENT_MODEL_ID?.trim()||'enterprise-model'}),
    private suiteGenerator:MigrationSuiteGenerator=(input,)=>generateSuiteWithAnalyzer(input,()=>configuredModelRole('ANALYZER'))) {}
  async target(){try{return {available:true,target:await nativeTarget()};}catch{return {available:false,message:'目标 Host 未就绪或模型连接不可用，请联系维护者。'};}}
  async verifyTarget(id:string,input:unknown){return this.serial(async()=>{
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
  private serial<T>(fn:()=>Promise<T>):Promise<T> {
    const p=this.chain.then(fn); this.chain=p.catch(()=>{}); return p;
  }
  async list() {return Promise.all((await listJsonFiles(path.join(this.root,'migrations'))).map(f=>readJson<Migration>(f)));}
  async get(id:string):Promise<Migration> {return readJson<Migration>(this.file(id));}
  async create(input:unknown) {
    const value=await this.serial(async()=>{
    const p=createSchema.parse(input), source=await this.skills.get(p.sourceAssetId);
    if (!source) return conflict('Source Skill unavailable');
    const existing=(await this.list()).find(item=>item.source.artifactSha256===source.artifactSha256&&item.name===p.name);
    if(existing)return existing;
    const value:Migration={schemaVersion:'finance.skill-migration.v2',id:'migration-'+randomUUID(),name:p.name,
      createdAt:new Date().toISOString(),source,candidate:null,candidateNotes:'',runs:[],assessment:'NOT_VALIDATED'};
    await writeJsonAtomic(this.file(value.id),value); return value;
    });
    void this.diagnostics?.diagnose(value.source).catch(()=>undefined);return value;
  }
  async upgrade(id:string){
    const legacy=await this.get(id),asset=legacy.candidate??legacy.source;
    if(legacy.schemaVersion==='finance.skill-migration.v2')return legacy;
    const upgraded=await this.create({sourceAssetId:asset.assetId,name:`${legacy.name} 2.0`});
    if(upgraded.legacySourceProjectId!==legacy.id){upgraded.legacySourceProjectId=legacy.id;await writeJsonAtomic(this.file(upgraded.id),upgraded);}
    return upgraded;
  }
  async diagnose(id:string,retry=false){const value=await this.get(id);
    if(!this.diagnostics)return conflict('Diagnostic service unavailable');
    return this.diagnostics.diagnose(value.source,retry);
  }
  async inspect(id:string){return this.serial(async()=>{
    const value=await this.get(id),asset=value.candidate??value.source,archive=await this.skills.readArchive(asset.assetId);
    const files:Record<string,string>={};
    for(const [name,bytes] of Object.entries(archive))try{files[name]=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{}

    // A2 runs as an agent, and the analysis is the only source of Tools and of the baseline
    // (each Tool's input/output and samples). There is no rules fallback: reading a package is a
    // judgement, and every rule that tried to do it by pattern-matching invented something the
    // source never declared. Without an analysis there is no baseline, so there is nothing to
    // migrate against -- better to say that than to hand the flow a guess.
    const agent=await this.analyzer({assetDigest:asset.artifactSha256,runId:id,files:archive}).catch(()=>null);
    // An abstention is the agent's judgement, so it is reported as one: whoever reads this gets the
    // agent's own account of what it could not read, not a generic "unavailable".
    if(agent?.status==='ABSTAINED')return conflict(
      `分析 agent 判定这个工程无法完成分析：${agent.reason}${agent.missing.length?`（缺 ${agent.missing.join('、')}）`:''}。请补齐后重新检查。`);
    let inspection:ProjectInspection|null=null;
    if(agent?.status==='PRODUCED'){
      try{
        const candidate=toProjectInspection(agent.payload as never,asset.assetId,asset.artifactSha256,stableToolId,agent.scanner??null,files);
        // An inspection with neither tools nor a skill verdict carries no information.
        if(candidate.tools.length||candidate.skill.status!=='UNKNOWN')inspection=candidate;
      }catch{inspection=null;}
    }
    if(!inspection)return conflict('分析不可用：A2 agent 未产出工具与基线。静态规则不再猜测工具与输入输出，因此无法继续迁移。');
    value.inspection=inspection;
    // The baseline is a stage product, so it is recorded as one: what produced it and what it was
    // bound to. Without the binding there is no way to say later whether it still describes the
    // asset it was written for (L1 §3.5 rule 1).
    value.analysis=stageEnvelope({assetDigest:asset.artifactSha256,stageId:'A2',producer:'AGENT',status:'PRODUCED',
      payload:inspection});
    value.decisions=(value.decisions??[]).filter(decision=>decision.baseAssetId===asset.assetId&&value.inspection!.tools.some(tool=>tool.toolId===decision.toolId));
    await writeJsonAtomic(this.file(id),value);return value.inspection;
  });}
  async inspection(id:string){const value=await this.get(id),asset=value.candidate??value.source;
    if(!value.inspection||value.inspection.assetId!==asset.assetId)return this.inspect(id);
    // The asset id says which asset, the digest says which contents. A record written before
    // 0.1 → 2.0 upgrade can carry an inspection for an asset whose bytes have since moved, and the
    // binding is what catches that.
    if(value.analysis&&staleAgainst(value.analysis,{asset:asset.artifactSha256}))return this.inspect(id);
    return value.inspection;
  }
  async decide(id:string,toolId:string,input:unknown){return this.serial(async()=>{
    const p=z.strictObject({form:z.enum(['MCP','SCRIPT']),language:z.string().min(1).max(40).optional(),reason:z.string().min(1).max(1000).optional(),baseAssetId:z.string().min(1)}).parse(input);
    const value=await this.get(id),asset=value.candidate??value.source;
    if(p.baseAssetId!==asset.assetId)return conflict('资产已变化，请刷新检查结果后重新确认');
    if(!value.inspection||value.inspection.assetId!==asset.assetId)return conflict('请先检查当前资产');
    const tool=value.inspection.tools.find(item=>item.toolId===toolId);if(!tool)return conflict('当前检查结果中不存在这个 Tool');
    const decision:ToolDecision={toolId,form:p.form,...(p.language?{language:p.language}:{}),reason:p.reason??(p.form==='MCP'?'迁移到本 Skill 的共享 MCP 服务':'迁移为独立脚本 Tool'),baseAssetId:p.baseAssetId,decidedAt:new Date().toISOString()};
    value.decisions=[...(value.decisions??[]).filter(item=>!(item.toolId===toolId&&item.baseAssetId===p.baseAssetId)),decision];
    await writeJsonAtomic(this.file(id),value);return decision;
  });}
  async plan(id:string){const value=await this.get(id),asset=value.candidate??value.source;
    if(!value.inspection||value.inspection.assetId!==asset.assetId)return conflict('请先检查当前资产');
    return buildMigrationPlan(value.inspection,value.decisions??[],asset.assetId);
  }
  /**
   * A4 runs as an agent; the configured MIGRATION model is the fallback when the
   * agent runtime is absent. The judged contract is the source tool's own input/output
   * shape -- the agent supplies the implementation, never the test.
   */
  private async generateImplementations(archive:Record<string,Uint8Array>,inspection:ProjectInspection,decisions:ToolDecision[],asset:SkillAssetRecord,plan:MigrationPlan){
    {
      // The contract takes its language from the plan the human approved, so what is
      // generated cannot disagree with what was shown to them. What *to preserve* comes from
      // the analysis; how to build and start it is the agent's own answer.
      const contract:Record<string,unknown>={};
      for(const decision of decisions){
        const tool=inspection.tools.find(item=>item.toolId===decision.toolId);
        const language=plan.items.find(item=>item.toolId===decision.toolId)?.language
          ??recommendLanguage(decision.form,tool?.language??null);
        const sample=contractSample(tool);
        contract[decision.toolId]={form:decision.form,language,toolName:tool?.name??'',
          inputSchema:tool?.inputSchema??null,outputSchema:tool?.outputSchema??null,
          samples:(tool?.samples??[]).map(item=>item.input),
          // No sample means the call cannot be exercised. Report that rather than invent one.
          ...('reason' in sample?{sampleMissing:sample.reason}:{sampleInput:sample.input})};
      }
      // A4 is not deterministic: the same input can produce or stall. Retry the run a
      // bounded number of times, but treat ABSTAINED as a decision, not a flake.
      const attempts=Math.max(1,Number(process.env.FINANCE_EVAL_AGENT_ATTEMPTS??2));
      for(let attempt=1;attempt<=attempts;attempt++){
      const result=await this.implementer({
        assetDigest:asset.artifactSha256,runId:asset.assetId,files:archive,
        decisions:decisions.map(d=>({toolId:d.toolId,form:d.form,language:d.language})),
        tools:inspection.tools.map(t=>({toolId:t.toolId,name:t.name,language:t.language,sourcePaths:t.sourcePaths,inputSchema:t.inputSchema,outputSchema:t.outputSchema,samples:t.samples})),
        contract,
      });
      if(result?.status==='PRODUCED'||result?.status==='ABSTAINED'){
        // An abstention is a decision that belongs to a human. Report which Tool and why,
        // rather than letting the packager fail with a generic message.
        const reported=((result.payload as {tools?:Array<{toolId?:string;status?:string;reason?:string;missing?:string[]}>}).tools??[])
          .filter(item=>String(item.status??'').toUpperCase()==='ABSTAINED');
        if(reported.length){
          const detail=reported.map(item=>`${item.toolId||'未知 Tool'}：${item.reason?.trim()||'未说明原因'}${
            item.missing?.length?`（缺 ${item.missing.join('、')}）`:''}`).join('；');
          throw Object.assign(new Error(`有 Tool 无法忠实迁移，已停止生成并退回授权环节重新决策。${detail}`),{statusCode:409});
        }
        if(result.status==='ABSTAINED')throw Object.assign(new Error(
          `迁移模型无法完成本次迁移，已退回授权环节重新决策。${String((result.payload as {reason?:string}).reason??'').trim()}`),{statusCode:409});
      }
      if(result?.status==='PRODUCED'){
        const nameById=Object.fromEntries(inspection.tools.map(tool=>[tool.toolId,tool.name]));
        const mapped=toGeneratedImplementations(result.payload as never,result.files,nameById);
        if(Object.keys(mapped).length)return mapped;
      }
      }
    }
    return this.codeGenerator.generate({archive,inspection,decisions});
  }
  private async generatePortable(id:string,input:unknown){return this.serial(async()=>{
    const p=z.strictObject({baseAssetId:z.string().min(1),acknowledgePartialAnalysis:z.boolean().optional()}).parse(input),value=await this.get(id),asset=value.candidate??value.source;
    if(p.baseAssetId!==asset.assetId)return conflict('资产已变化，请刷新后重新生成');
    if(!value.inspection||value.inspection.assetId!==asset.assetId)return conflict('请先检查当前资产');
    if(!value.inspection.staticAnalysis||value.inspection.staticAnalysis.status==='UNAVAILABLE')return conflict('静态分析不可用，已阻止生成候选');
    const toolPaths=new Set(value.inspection.tools.flatMap(tool=>tool.sourcePaths));
    const toolIncompleteFiles=value.inspection.staticAnalysis.toolIncompleteFiles??value.inspection.staticAnalysis.incompleteFiles.filter(item=>toolPaths.has(item.path));
    if(toolIncompleteFiles.length&&!p.acknowledgePartialAnalysis){
      const files=toolIncompleteFiles.map(item=>`${item.path} (${item.status})`).join('、');
      return conflict(`静态分析未完整覆盖 Tool 相关源码；确认人工审阅后才能继续：${files}`);
    }
    const plan=buildMigrationPlan(value.inspection,value.decisions??[],asset.assetId);if(!plan.generationAllowed)return conflict('当前逐 Tool 决策尚不能生成候选');
    const archive=await this.skills.readArchive(asset.assetId),version=`2.0.0-migration.${(value.candidateHistory?.length??0)+1}`;
    // Clear the previous generation before regenerating. The recorded diff is the only
    // reliable list of what was generated -- matching on a path prefix does not work,
    // because the generator writes mcp/ skill/ scripts/, not a generated/ root.
    for(const item of value.portableGenerationDiff??[]){
      const current=archive[item.path];
      if(current===undefined)continue;
      if(Buffer.from(current).toString('utf8')!==item.after)return conflict('生成文件已被人工修改；为避免覆盖工程改动，请将其作为新实现重新导入和检查');
      delete archive[item.path];
    }
    const decisions=value.decisions!.filter(d=>d.baseAssetId===asset.assetId);
    const implementations=await this.generateImplementations(archive,value.inspection,decisions,asset,plan);
    const generated=generatePortableCandidate({archive,base:asset,inspection:value.inspection,decisions,version,implementations});
    const candidate=await this.publishCandidate(generated.files);
    const candidateInspection=await this.inspectCandidate({candidate,files:generated.files,inspection:value.inspection,decisions:value.decisions!,baseAssetId:asset.assetId,generations:generated.generations});
    value.candidate=candidate;value.inspection=candidateInspection;value.candidateNotes='按逐 Tool 决策生成符合 Skill 规范的完整候选；原始资产保持不变。';value.portableGenerations=generated.generations;value.portableGenerationDiff=generated.diff;
    (value.candidateHistory??=[]).push({asset:candidate,notes:value.candidateNotes,recordedAt:new Date().toISOString(),kind:'migration'});
    await writeJsonAtomic(this.file(id),value);return value;
  });}
  /** Turn placed files into an asset. Separate from generating them: this is the step that makes
   * the result referenceable, and it has nothing to say about whether the code is any good. */
  private async publishCandidate(files:Record<string,Uint8Array>):Promise<SkillAssetRecord>{
    return this.skills.uploadZip(Buffer.from(zipSync(files)));
  }
  /**
   * The candidate's own check, after it exists.
   *
   * It is a separate method because it is a separate cost and a separate failure: the scanner plus
   * a model call, against the generation's model call or agent run. Folded into one method, a slow
   * or failing check decided whether generation was attempted at all -- and the two are worth
   * reporting apart.
   */
  private async inspectCandidate(input:{candidate:SkillAssetRecord;files:Record<string,Uint8Array>;
    inspection:ProjectInspection;decisions:ToolDecision[];baseAssetId:string;generations:PortableGeneration[]}):Promise<ProjectInspection>{
    const decoded:Record<string,string>={};for(const [name,bytes] of Object.entries(input.files))try{decoded[name]=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{}
    if(!this.diagnostics)return conflict('静态诊断服务不可用，不能确认生成候选');
    let candidateDiagnosis;
    try{candidateDiagnosis=await this.diagnostics.diagnose(input.candidate);}
    catch{return conflict('生成候选的静态诊断执行失败，候选未被采纳；请检查 uv、锁文件和扫描器配置');}
    if(candidateDiagnosis.digest!==input.candidate.artifactSha256)return conflict('生成候选的静态诊断与资产不匹配');
    const candidateInspection=inspectProject({assetId:input.candidate.assetId,assetDigest:input.candidate.artifactSha256,files:decoded,skillFile:input.candidate.skillFile,diagnosis:candidateDiagnosis});
    if(candidateInspection.skill.status!=='COMPLIANT'){
      const errors=candidateInspection.skill.findings.filter(item=>item.severity==='ERROR').map(item=>`${item.code}: ${item.message}`).join('；');
      return conflict(`生成候选不符合 Skill 包规范，候选未被采纳：${errors||'Skill 检查未通过'}`);
    }
    // Describe what was generated instead of asserting a language: asserting it made the
    // record say Python for a Node script and Java for anything that was not Java.
    candidateInspection.tools=input.inspection.tools.map(tool=>{
      const decision=input.decisions.find(item=>item.toolId===tool.toolId&&item.baseAssetId===input.baseAssetId)!;
      const generation=input.generations.find(item=>item.toolId===tool.toolId)!;
      if(decision.form==='SCRIPT'){
        const entry=generation.entrypoint??generation.files.find(name=>CODE_FILE.test(name))!;
        return {...tool,sourcePaths:[entry],language:languageOfSourcePaths([entry]),kind:'SCRIPT' as const,portability:'PORTABLE_SCRIPT' as const,entrypoint:{kind:(/\.py$/iu.test(entry)?'PYTHON':'NODE') as 'PYTHON'|'NODE',path:entry},findings:[]};
      }
      const generatedFiles=generation.files.filter(name=>CODE_FILE.test(name));
      return {...tool,sourcePaths:generatedFiles,language:languageOfSourcePaths(generatedFiles),kind:'MCP' as const,portability:'PORTABLE_MCP' as const,entrypoint:undefined,findings:[]};
    });
    return candidateInspection;
  }
  async validateTechnical(id:string,input:unknown,signal?:AbortSignal){return this.serial(async()=>{
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
    const scripts=inspection.tools.filter(tool=>tool.kind==='SCRIPT'&&tool.entrypoint)
      .map(tool=>{const entry=tool.entrypoint!.path!.replaceAll('\\','/');let root=entry.split('/').slice(0,-1).join('/'),cursor=root;
        while(true){const prefix=cursor?`${cursor}/`:'';if(archive[`${prefix}pyproject.toml`]||archive[`${prefix}package.json`]){root=cursor;break;}if(!cursor)break;cursor=cursor.split('/').slice(0,-1).join('/');}
        const filePaths=Object.keys(archive).filter(name=>(!root||name.startsWith(`${root}/`))&&/\.(?:py|js|mjs|cjs|json|toml|lock)$/iu.test(name));
        return {name:tool.name,path:entry,kind:tool.entrypoint!.kind,filePaths,...(tool.inputSchema?{inputSchema:tool.inputSchema}:{})};});
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
  private async generateLegacy(id:string,input:unknown){return this.serial(async()=>{
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
  async candidate(id:string,input:unknown) {return this.serial(async()=>{
    const p=candidateSchema.parse(input), value=await this.get(id), candidate=await this.skills.get(p.assetId);
    if (!candidate || candidate.artifactSha256===value.source.artifactSha256) return conflict('Import a separate versioned candidate; source remains immutable');
    if (candidate.version===value.source.version) return conflict('Candidate must use a new version');
    value.candidate=candidate; value.candidateNotes=p.notes;
    delete value.inspection;value.decisions=[];delete value.portableGenerations;delete value.portableGenerationDiff;
    (value.candidateHistory??=[]).push({asset:candidate,notes:p.notes,recordedAt:new Date().toISOString()});
    await writeJsonAtomic(this.file(id),value); return value;
  });}
  async draft(id:string,input:unknown) {return this.serial(async()=>{
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
  async review(id:string,input:unknown){return this.serial(async()=>{
    const p=z.strictObject({baseAssetId:z.string(),decision:z.enum(['ACCEPTED','NEEDS_CHANGES']),notes:z.string().min(1).max(2000)}).parse(input);
    const value=await this.get(id);
    if(!value.candidate||p.baseAssetId!==value.candidate.assetId)return conflict('候选已变化，请对当前版本重新记录专业复核');
    (value.reviews??=[]).push({candidateDigest:value.candidate.artifactSha256,decision:p.decision,notes:p.notes,recordedAt:new Date().toISOString(),source:'PRIVATE_ADMIN_RECORDED'});
    await writeJsonAtomic(this.file(id),value);return value;
  });}
  async createSuite(id:string,input:unknown) {return this.serial(async()=>{
    const p=manualPreparationSchema.parse(input),value=await this.get(id);
    if (!this.preparations) return conflict('Preparation store unavailable');
    const suite=await this.preparations.create({skill:value.source,summary:p.summary,cases:p.cases,holdoutCases:p.holdoutCases,source:'manual'});
    (value.suiteIds??=[]).push(suite.preparationId);await writeJsonAtomic(this.file(id),value);return suite;
  });}
  /**
   * The test set, generated from the analysis rather than typed in by hand.
   *
   * It is built from the *source* asset, never the candidate: a test set written against what was
   * just generated would be graded by the thing it is supposed to check. The analysis supplies the
   * tool surface, so a question cannot require a Tool the Skill never had.
   */
  async generateSuite(id:string,input:unknown) {return this.serial(async()=>{
    const p=z.strictObject({baseAssetId:z.string().min(1),maximumCases:z.number().int().min(1).max(8).optional()}).parse(input);
    const value=await this.get(id),current=value.candidate??value.source,asset=value.source;
    if(p.baseAssetId!==current.assetId)return conflict('资产已变化，请刷新后重新生成测试集');
    if(!value.inspection||value.inspection.assetId!==current.assetId)return conflict('测试集要从分析结果生成，请先检查当前资产');
    if(!this.preparations)return conflict('Preparation store unavailable');
    const decoded=await this.decodedSkillSource(asset);
    const generated=await this.suiteGenerator({
      skillId:asset.skillId,
      skillSource:`${decoded}\n\n${baselineBrief(value.inspection)}`,
      tools:value.inspection.tools.map(tool=>tool.name),
      ...(p.maximumCases===undefined?{}:{maximumCases:p.maximumCases}),
      generationId:`migration-suite-${id}`,
    });
    const suite=await this.preparations.create({skill:asset,summary:generated.summary,cases:generated.cases,source:'ai_generated'});
    (value.suiteIds??=[]).push(suite.preparationId);await writeJsonAtomic(this.file(id),value);return suite;
  });}
  /** The Skill's own words, plus its references. Professional references only -- never a candidate's
   * generated files, and never anything that looks like an answer key. */
  private async decodedSkillSource(asset:SkillAssetRecord):Promise<string>{
    const archive=await this.skills.readArchive(asset.assetId),decode=(name:string)=>{
      const bytes=archive[name];if(!bytes)return '';try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return '';}
    };
    let remaining=24_000;
    const parts=[`# SKILL.md\n${decode(asset.skillFile).slice(0,remaining)}`];
    remaining-=Math.min(remaining,parts[0]!.length);
    for(const name of Object.keys(archive).sort()){
      if(remaining<=0)break;
      if(!/^references\/.*\.md$/u.test(name)||/evals?\/|holdout|sealed|labels/iu.test(name))continue;
      const text=decode(name).slice(0,Math.min(remaining,8_000));
      parts.push(`# ${name}\n${text}`);remaining-=text.length;
    }
    return parts.join('\n\n');
  }
  async optimize(id:string,input:unknown) {return this.serial(async()=>{
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
  async adoptOptimization(id:string,input:unknown) {return this.serial(async()=>{
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
  async validate(id:string,input:unknown) {return this.serial(async()=>{
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
    if(p.pair==='BC'&&p.configuration.evaluationMode!=='candidate_assessment')return conflict('BC is a migrated-candidate quality assessment, not a left/right winner comparison');
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
    // V2 exports are the standard Skill/Tool delivery itself. Migration evidence
    // remains available from /report and must not pollute the specified package.
    if(value.schemaVersion==='finance.skill-migration.v2')return Buffer.from(zipSync(files));
    const state=report.verification.targetExecution==='PASSED'?'TARGET_VERIFIED_CANDIDATE':'DRAFT_NOT_VALIDATED';
    const manifest={schemaVersion:'finance.skill-migration.exchange.v0.1',projectId:id,source:value.source,candidate:value.candidate,
      state,builderImport:'NOT_VERIFIED',installationLock:'ASSEMBLER_RESPONSIBILITY',
      executionPolicy:'INERT_ARCHIVE_ONLY_NO_SCRIPT_EXECUTION',dependencies:'NOT_VALIDATED',
      fileDigestAlgorithm:'SHA-256 of original file bytes',
      files:Object.fromEntries(Object.entries(files).map(([name,content])=>[name,createHash('sha256').update(content).digest('hex')]))};
    return Buffer.from(zipSync({...files,'migration-manifest.json':strToU8(JSON.stringify(manifest,null,2)),
      'migration-report.json':strToU8(JSON.stringify({schemaVersion:'migration.export-scope.v1',state,
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
