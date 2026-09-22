import { createHash } from 'node:crypto';
import { z } from 'zod';
import { zipSync, strToU8 } from 'fflate';
import { fingerprint } from '../contracts.js';
import type { SkillStore, SkillAssetRecord } from './skill-store.js';
import type { EvaluationRunManager } from './run-manager.js';
import type { EvaluationJobStore } from './job-store.js';
import type { EvalPackCatalog } from './catalog.js';
import { runConfigurationSchema } from './contracts.js';
import type { PreparationStore } from './preparation-store.js';
import type { OptimizationManager } from './optimization-manager.js';
import { configuredModelRole } from './config.js';
import { MigrationDiagnostics } from './migration-diagnostics.js';
import { generateCandidateFiles, versionedMethod, regenerationArchive } from './migration-candidate.js';
import type { EnvironmentStore } from './environment-store.js';
import { MigrationTargetRuns, nativeTarget } from './migration-target.js';
import { inspectProject } from './tool-inspector.js';
import {buildMigrationPlan,languageOfSourcePaths,recommendLanguage,supportsImplicitScriptContext,type MigrationPlan,type ProjectInspection,type TechnicalValidation,type ToolDecision,type ToolInspection } from './migration-model.js';
import {runtimeToolConfigTemplate,validateAgentRuntimeDelivery} from './migration-delivery-contract.js';
import {runtimeBuildRequirements} from './migration-harness.js';
import {MigrationRuntimeConfig,configurationDigest,runtimeInjection,migrationExecutionConfig,serviceEnvironment} from './migration-runtime-config.js';
import { analyzeWithAgent,contractSample,implementWithAgent,toGeneratedImplementations,toSkillDocumentDelivery,type MigrationAnalyzer,type MigrationImplementer } from './migration-agent.js';
import { generatePortableCandidate,type PortableGeneration } from './portable-candidate.js';
import {generateSuiteWithAnalyzer,type MigrationSuiteGenerator } from './migration-suite.js';
import {originalServiceFingerprint} from '../original-service-runtime.js';
import { TechnicalValidationService,pythonCommand } from './technical-validation.js';
import { MigrationCodeGenerator } from './migration-code-generator.js';
import { assessMigrationAcceptance } from './migration-acceptance.js';
import {MigrationSupplements} from './migration-supplements.js';
import { MigrationProjectRepository } from '../migration/infrastructure/migration-project-repository.js';
import type { MigrationProject } from '../migration/domain/migration-project.js';
import { MigrationProjectService } from '../migration/application/migration-project-service.js';
import { MigrationInspectionService, type MigrationRuntimeReference } from '../migration/application/migration-inspection-service.js';
import { MigrationSuiteService } from '../migration/application/migration-suite-service.js';

const candidateSchema = z.strictObject({assetId:z.string().min(1), notes:z.string().min(1).max(8000)});
const draftSchema = z.strictObject({
  source:z.string().min(1).max(128000), notes:z.string().min(1).max(8000),
  baseAssetId:z.string().min(1),
  autoVersion:z.boolean().optional(),
});
const planSchema = z.strictObject({
  pair:z.enum(['AB','BC','AC','SC']), configuration:runConfigurationSchema,
  dataSnapshot:z.string().min(1).max(300), permissionBasis:z.string().min(1).max(1000),
  sourceProjectRef:z.string().min(1).max(1000), dependencyLockRef:z.string().min(1).max(1000),
});
const conflict = (message:string):never => {throw Object.assign(new Error(message),{statusCode:409});};
const CODE_FILE=/\.(?:java|py|js|mjs|cjs|ts)$/iu;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
type TestInput={value:unknown;source:NonNullable<TechnicalValidation['inputSource']>;fields:string[]};
function schemaValue(schema:unknown):{available:boolean;value?:unknown}{
  if(!record(schema))return {available:false};
  if('const' in schema)return {available:true,value:schema.const};
  if('default' in schema)return {available:true,value:schema.default};
  if(Array.isArray(schema.examples)&&schema.examples.length)return {available:true,value:schema.examples[0]};
  if(Array.isArray(schema.enum)&&schema.enum.length)return {available:true,value:schema.enum[0]};
  return {available:false};
}
function automaticTestInput(tool:ToolInspection,provided:unknown):TestInput{
  if(provided!==undefined){
    if(tool.kind==='MCP'&&!record(provided))return conflict('MCP 工具的业务参数必须是对象');
    return {value:provided,source:'USER',fields:record(provided)?Object.keys(provided):[]};
  }
  const sample=tool.samples.find(item=>record(item.input));
  if(sample)return {value:sample.input,source:'SOURCE_SAMPLE',fields:Object.keys(sample.input as Record<string,unknown>)};
  if(record(tool.inputSchema)){
    const properties=record(tool.inputSchema.properties)?tool.inputSchema.properties:{},required=Array.isArray(tool.inputSchema.required)?tool.inputSchema.required.filter((name):name is string=>typeof name==='string'):[];
    const value:Record<string,unknown>={},missing:string[]=[];
    for(const name of required){const resolved=schemaValue(properties[name]);if(resolved.available)value[name]=resolved.value;else missing.push(name);}
    if(missing.length)return conflict(`试运行需要补充真实业务测试值：${missing.join('、')}`);
    return {value,source:'SCHEMA_DEFAULT',fields:Object.keys(value)};
  }
  return {value:{},source:'EMPTY',fields:[]};
}

/** Separate migration snapshots from optimization jobs. No uploaded code is executed here. */
export class MigrationStore {
  private readonly projects: MigrationProjectRepository;
  private readonly projectService: MigrationProjectService;
  private readonly inspectionService: MigrationInspectionService;
  private readonly suiteService: MigrationSuiteService;
  constructor(private root:string, private skills:SkillStore, private runs:EvaluationRunManager,
    private jobs:EvaluationJobStore, private catalog:EvalPackCatalog, private preparations?:PreparationStore,
    private optimizers?:OptimizationManager, private diagnostics?:MigrationDiagnostics, private environments?:EnvironmentStore,
    private codeGenerator=new MigrationCodeGenerator(()=>configuredModelRole('MIGRATION')),
    analyzer:MigrationAnalyzer=(input,)=>analyzeWithAgent(input,{projectRoot:process.env.FINANCE_EVAL_ROOT?.trim()||process.cwd(),
      modelId:process.env.FINANCE_EVAL_AGENT_MODEL_ID?.trim()||'enterprise-model'}),
    private implementer:MigrationImplementer=(input,)=>implementWithAgent(input,{projectRoot:process.env.FINANCE_EVAL_ROOT?.trim()||process.cwd(),
      modelId:process.env.FINANCE_EVAL_AGENT_MODEL_ID?.trim()||'enterprise-model'}),
    suiteGenerator:MigrationSuiteGenerator=(input,)=>generateSuiteWithAnalyzer(input,()=>configuredModelRole('ANALYZER')),
    projects?: MigrationProjectRepository) {
    this.projects = projects ?? new MigrationProjectRepository(root);
    this.projectService = new MigrationProjectService(this.projects, skills, diagnostics);
    this.inspectionService = new MigrationInspectionService(root, this.projects, skills, analyzer);
    this.suiteService = new MigrationSuiteService(this.projects, skills, analyzer, suiteGenerator, preparations);
  }
  private async migrationEnvironment(environmentId:string){
    return await this.environments?.get(environmentId)??null;
  }
  async target(){try{return {available:true,target:await nativeTarget()};}catch{return {available:false,message:'目标 Host 未就绪或模型连接不可用，请联系维护者。'};}}
  async verifyTarget(id:string,input:unknown){return this.serial(id,async()=>{
    const p=z.strictObject({baseAssetId:z.string()}).parse(input),value=await this.get(id);
    if(!value.candidate||p.baseAssetId!==value.candidate.assetId)return conflict('候选已变化，请刷新后验证');
    if(!value.simulationProfile||value.generation?.candidateDigest!==value.candidate.artifactSha256)return conflict('请先审阅映射并生成当前候选；修改后需重新审阅');
    const runner=new MigrationTargetRuns(this.root,this.skills);
    for(const runId of value.targetRuns??[])if((await runner.get(runId)).status==='RUNNING')return conflict('当前项目已有验证正在运行');
    const run=await runner.start(value.candidate,value.simulationProfile);(value.targetRuns??=[]).push(run.id);await this.projects.save(value);return run;
  });}
  private serial<T>(id:string,fn:()=>Promise<T>):Promise<T> {
    return this.projects.runExclusive(id,fn);
  }
  async list() {return this.projectService.list();}
  async get(id:string):Promise<MigrationProject> {return this.projectService.get(id);}
  async create(input:unknown) {return this.projectService.create(input);}
  async upgrade(id:string){return this.projectService.upgrade(id);}
  async diagnose(id:string,retry=false){return this.projectService.diagnose(id,retry);}
  async inspect(id:string,sourceOnly=false){return this.inspectionService.inspect(id,sourceOnly);}
  async dependencyData(id:string,dependencyId:string){
    return this.inspectionService.dependencyData(id,dependencyId);
  }
  async runtimeConfiguration(id:string){
    return this.inspectionService.runtimeConfiguration(id);
  }
  async saveRuntimeDependency(id:string,dependencyId:string,input:unknown){return this.inspectionService.saveRuntimeDependency(id,dependencyId,input);}
  async resolveRuntimeDependencies(reference:MigrationRuntimeReference){return this.inspectionService.resolveRuntimeDependencies(reference);}
  async resolveServiceEnvironment(reference:MigrationRuntimeReference,toolNames:string[]){return this.inspectionService.resolveServiceEnvironment(reference,toolNames);}
  async checkBusinessConnection(id:string,input:unknown,signal?:AbortSignal){return this.inspectionService.checkBusinessConnection(id,input,signal);}
  async supplementDependency(id:string,dependencyId:string,input:unknown){return this.inspectionService.supplementDependency(id,dependencyId,input);}
  async uploadDependency(id:string,dependencyId:string,revision:number,filename:string,bytes:Buffer){return this.inspectionService.uploadDependency(id,dependencyId,revision,filename,bytes);}
  async explainDependency(id:string,dependencyId:string,input:unknown){return this.inspectionService.explainDependency(id,dependencyId,input);}
  async inspection(id:string){return this.inspectionService.inspection(id);}
  async decide(id:string,toolId:string,input:unknown){return this.inspectionService.decide(id,toolId,input);}
  async plan(id:string){return this.inspectionService.plan(id);}
  async runtimeRequirements(id:string){return this.inspectionService.runtimeRequirements(id);}
  async runtimeRequirementsYaml(id:string){return this.inspectionService.runtimeRequirementsYaml(id);}
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
          dependencies:inspection.dependencyAnalysis?.dependencies.filter(d=>d.toolIds.includes(decision.toolId))??[],
          runtimeInjection:'SERVICE_ENV dependencies are startup configuration: read the declared environment variable inside the MCP service, never from request Headers or business arguments. Actual values are supplied by the launcher, never sent to this model. runtimeToolConfig is for MCP only: contextBindings map HTTP Header names to context references, auth providers return request headers, and business arguments remain separate. Script runs through generic command with no additional Runtime injection. Never ask the model to supply injected fields.',
          inputSchema:tool?.inputSchema??null,outputSchema:tool?.outputSchema??null,
          samples:(tool?.samples??[]).map(item=>item.input),
          // No sample means the call cannot be exercised. Report that rather than invent one.
          ...('reason' in sample?{sampleMissing:sample.reason}:{sampleInput:sample.input})};
      }
      // A4 is not deterministic: the same input can produce or stall. Retry the run a
      // bounded number of times, but treat ABSTAINED as a decision, not a flake.
      // Re-running the whole code agent repeats every model/tool round and can double a long
      // request without adding new evidence.  A user retry is explicit and keeps the failed run
      // visible, so automatic whole-agent retry is opt-in only.
      const attempts=Math.max(1,Number(process.env.FINANCE_EVAL_AGENT_ATTEMPTS??1));
      // Remembered so the fallback is only reached when the agent is genuinely unavailable: an
      // agent that ran and failed has a reason, and that reason is what the reader needs.
      let agentFailure:string|null=null;
      for(let attempt=1;attempt<=attempts;attempt++){
      const result=await this.implementer({
        assetDigest:asset.artifactSha256,runId:asset.assetId,files:archive,
        decisions:decisions.map(d=>({toolId:d.toolId,form:d.form,language:d.language})),
        tools:inspection.tools.map(t=>({toolId:t.toolId,name:t.name,language:t.language,sourcePaths:t.sourcePaths,inputSchema:t.inputSchema,outputSchema:t.outputSchema,samples:t.samples,migrationContract:contract[t.toolId]})),
        contract,
        deliveryContract:{skillDocumentation:{sourceSkillFile:asset.skillFile,manifestPathsRelativeToSkillRoot:true},script:{execution:"COMMAND",cwd:"WORKSPACE",entrypoint:"RUNTIME_PROVIDED_ABSOLUTE_PATH",packageResources:"RELATIVE_TO_SCRIPT",runtimeInjection:false},mcp:{contextTransport:"HTTP_HEADER",serviceConfigurationTransport:"SERVICE_ENV",businessArguments:"SEPARATE",pythonFramework:{package:"fastmcp",version:"2.14.7",import:"from fastmcp import FastMCP"}},runtimeToolConfigTemplate:runtimeToolConfigTemplate(inspection,decisions)},
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
      if(result?.status==='FAILED'){agentFailure=result.reason;continue;}
      if(result?.status==='PRODUCED'){
        const deliveryIssues=validateAgentRuntimeDelivery(result.payload as Record<string,unknown>,inspection,decisions);
        if(deliveryIssues.length){agentFailure=deliveryIssues.join('；');continue;}
        const nameById=Object.fromEntries(inspection.tools.map(tool=>[tool.toolId,tool.name]));
        const mapped=toGeneratedImplementations(result.payload as never,result.files,nameById);
        const skillDelivery=toSkillDocumentDelivery(result.payload as never,result.files);
        const missing=decisions.filter(decision=>!mapped[decision.toolId]||mapped[decision.toolId]!.language!==plan.items.find(item=>item.toolId===decision.toolId)?.language);
        if(!missing.length&&skillDelivery)return {implementations:mapped,skillDelivery};
        if(!skillDelivery){agentFailure='A4 没有按文档清单交付最终 SKILL.md；平台不会在模型完成后替它机械合并或拆分 references';continue}
        agentFailure=`A4 交付不完整或语言与授权不符：${missing.map(decision=>nameById[decision.toolId]??decision.toolId).join('、')}`;
      }
      }
      if(agentFailure)return conflict(
        `迁移 agent 跑完了但没交付可用结果：${agentFailure}。这是执行问题不是工程问题——不会退回只能产出脚本的回退生成器。请重试或查看 agent 日志。`);
    }
    return {implementations:await this.codeGenerator.generate({archive,inspection,decisions})};
  }
  private async generatePortable(id:string,input:unknown){return this.serial(id,async()=>{
    const p=z.strictObject({baseAssetId:z.string().min(1),acknowledgePartialAnalysis:z.boolean().optional()}).parse(input),value=await this.get(id),currentAsset=value.candidate??value.source;
    if(p.baseAssetId!==currentAsset.assetId)return conflict('资产已变化，请刷新后重新生成');
    if(!value.inspection||value.inspection.assetId!==currentAsset.assetId)return conflict('请先检查当前资产');
    const generationInspection=value.sourceInspection??value.inspection;
    if(!generationInspection.staticAnalysis||generationInspection.staticAnalysis.status==='UNAVAILABLE')return conflict('静态分析不可用，已阻止生成候选');
    const toolPaths=new Set(generationInspection.tools.flatMap(tool=>tool.sourcePaths));
    const toolIncompleteFiles=generationInspection.staticAnalysis.toolIncompleteFiles??generationInspection.staticAnalysis.incompleteFiles.filter(item=>toolPaths.has(item.path));
    if(toolIncompleteFiles.length&&!p.acknowledgePartialAnalysis){
      const files=toolIncompleteFiles.map(item=>`${item.path} (${item.status})`).join('、');
      return conflict(`静态分析未完整覆盖 Tool 相关源码；确认人工审阅后才能继续：${files}`);
    }
    const plan=buildMigrationPlan(value.inspection,value.decisions??[],currentAsset.assetId);if(!plan.generationAllowed)return conflict('当前逐 Tool 决策尚不能生成候选');
    // Every regeneration is a fresh derivation from the immutable source package.  Building on
    // the previous candidate made generated guidance accumulate and allowed preserved references
    // to disappear when an ADD diff was cleared.
    const archive=await this.skills.readArchive(value.source.assetId),version=`2.0.0-migration.${(value.candidateHistory?.length??0)+1}`;
    for(const item of (await new MigrationSupplements(this.root).get(id)).items)for(const [name,content] of Object.entries(item.files??{}))archive[name]=Buffer.from(content,'base64');
    const decisions=value.decisions!.filter(d=>d.baseAssetId===currentAsset.assetId);
    const delivery=await this.generateImplementations(archive,generationInspection,decisions,value.source,plan);
    const generated=generatePortableCandidate({archive,base:value.source,inspection:generationInspection,decisions,version,...delivery});
    if(generationInspection.dependencyAnalysis?.dependencies.length){
      const path=decisions.some(d=>d.form==='MCP')?'runtime-dependencies.json':'scripts/runtime-dependencies.json';
      if(generated.files[path])return conflict('生成工程占用了运行依赖声明路径，请调整后重新生成');
      const declarations=generationInspection.tools.map(tool=>({tool:tool.name,dependencies:generationInspection.dependencyAnalysis!.dependencies.filter(d=>d.toolIds.includes(tool.toolId)&&d.owner==='RUNTIME'&&d.action==='INJECT').map(d=>({name:d.name,key:d.key,purpose:d.purpose,required:d.blocking,sensitive:d.sensitive,schema:d.schema,binding:d.binding}))}));
      const content=JSON.stringify({schemaVersion:'finance.tool-runtime-dependencies.v1',tools:declarations},null,2)+'\n';generated.files[path]=strToU8(content);generated.diff.push({path,operation:'ADD',before:'',after:content});
    }
    const candidate=await this.publishCandidate(generated.files,version);
    const candidateInspection=await this.inspectCandidate({candidate,files:generated.files,inspection:generationInspection,decisions:value.decisions!,baseAssetId:currentAsset.assetId,generations:generated.generations});
    // The candidate inspection describes the same logical tools on a new immutable asset. Carry
    // the authorized decisions forward to that asset; otherwise the report immediately claims
    // every decision is missing and disables regeneration as soon as generation succeeds.
    const carriedDecisions=decisions.map(decision=>({...decision,baseAssetId:candidate.assetId,decidedAt:new Date().toISOString()}));
    value.decisions=[...(value.decisions??[]),...carriedDecisions];
    value.candidate=candidate;value.inspection=candidateInspection;value.candidateNotes='按逐 Tool 决策生成符合 Skill 规范的完整候选；原始资产保持不变。';value.portableGenerations=generated.generations;value.portableGenerationDiff=generated.diff;
    (value.candidateHistory??=[]).push({asset:candidate,notes:value.candidateNotes,recordedAt:new Date().toISOString(),kind:'migration'});
    await this.projects.save(value);return value;
  });}
  /** Turn placed files into an asset. Separate from generating them: this is the step that makes
   * the result referenceable, and it has nothing to say about whether the code is any good. */
  private async publishCandidate(files:Record<string,Uint8Array>,version:string):Promise<SkillAssetRecord>{
    return this.skills.uploadZip(Buffer.from(zipSync(files)),{version});
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
    candidateInspection.dependencyAnalysis=input.inspection.dependencyAnalysis?structuredClone(input.inspection.dependencyAnalysis):undefined;
    candidateInspection.runtimeCapabilities=input.inspection.runtimeCapabilities?structuredClone(input.inspection.runtimeCapabilities):undefined;
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
        // No formal source schema is not the same as a tool taking no arguments. Expose
        // documented sample fields as hints, without claiming they are exhaustive/required.
        const sample=tool.samples.find(item=>item.input&&typeof item.input==='object'&&!Array.isArray(item.input))?.input as Record<string,unknown>|undefined;
        const inputSchema=tool.inputSchema??(sample?{type:'object',properties:Object.fromEntries(Object.entries(sample).map(([name,value])=>[name,
          value===null?{}:Array.isArray(value)?{type:'array'}:{type:typeof value==='object'?'object':typeof value}])),additionalProperties:true}:null);
        return {...tool,inputSchema,sourcePaths:[entry],language:languageOfSourcePaths([entry]),kind:'SCRIPT' as const,portability:'PORTABLE_SCRIPT' as const,entrypoint:{kind:(/\.py$/iu.test(entry)?'PYTHON':'NODE') as 'PYTHON'|'NODE',path:entry},findings:tool.inputSchema||!sample?[]:[{code:'SAMPLE_INPUT_HINTS',severity:'INFO' as const,path:entry,line:1,message:'输入字段来自原始样例，仅作调用提示，不是完整源 Schema'}]};
      }
      const generatedFiles=generation.files.filter(name=>CODE_FILE.test(name));
      return {...tool,sourcePaths:generatedFiles,language:languageOfSourcePaths(generatedFiles),kind:'MCP' as const,portability:'PORTABLE_MCP' as const,entrypoint:undefined,findings:[]};
    });
    return candidateInspection;
  }
  async validateTechnical(id:string,input:unknown,signal?:AbortSignal){return this.serial(id,async()=>{
    const p=z.strictObject({toolId:z.string().min(1),baseAssetId:z.string().min(1),request:z.unknown().optional(),endpoint:z.string().url().optional(),arguments:z.record(z.unknown()).optional()}).parse(input);
    const value=await this.get(id),asset=value.candidate??value.source;if(p.baseAssetId!==asset.assetId)return conflict('资产已变化，请刷新后重新验证');
    const inspection=value.inspection;if(!inspection)return conflict('请先完成 Tool 检查');
    if(runtimeBuildRequirements(value.sourceInspection??inspection))return conflict('检测到 Runtime Harness 改造需求；自动 Runtime Builder 功能开发中，当前版本暂不能验证此迁移');
    const tool=inspection.tools.find(item=>item.toolId===p.toolId);if(!tool)return conflict('当前检查结果中不存在这个 Tool');
    const testInput=automaticTestInput(tool,tool.kind==='MCP'?p.arguments:p.request);
    const generated=value.portableGenerations?.find(item=>item.toolId===tool.toolId);if(generated&&!generated.readyForValidation)return conflict('生成候选仍有待办，不能标记技术验证通过');
    const service=new TechnicalValidationService(),archive=await this.skills.readArchive(asset.assetId);
    const runtimeStore=new MigrationRuntimeConfig(this.root),runtimeConfig=await runtimeStore.get(id);
    const runtimeDeps=value.sourceInspection?.dependencyAnalysis?.dependencies.filter(d=>d.toolIds.includes(tool.toolId))??[];
    if(tool.kind==='SCRIPT'&&runtimeDeps.some(d=>d.owner==='RUNTIME'&&d.action==='INJECT'&&!supportsImplicitScriptContext(d)))return conflict('Script 不支持 Runtime 上下文或鉴权注入，请选择 MCP');
    const groupIds=(value.portableGenerations??[]).filter(g=>generated&&JSON.stringify([g.start,g.prepare])===JSON.stringify([generated.start,generated.prepare])).map(g=>g.toolId);
    const serviceDeps=value.sourceInspection?.dependencyAnalysis?.dependencies.filter(d=>d.toolIds.some(id=>[tool.toolId,...groupIds].includes(id)))??runtimeDeps;
    const environment=serviceEnvironment(serviceDeps,runtimeConfig.values);
    const injection=runtimeInjection(runtimeDeps,runtimeConfig.values,tool.kind==='MCP'?'HTTP_HEADER':'SCRIPT_CONTEXT');
    if(injection.missing.length)return conflict(`工具试运行缺少测试配置：${injection.missing.join('、')}`);
    // A Tool this platform migrated is one this platform starts: the deliverable declares the
    // command, and that command being usable is exactly what raising the service proves. An
    // endpoint is only for a Tool that was already an MCP server and has no deliverable at all.
    const migrated=Boolean(generated?.start?.length)||Boolean(generated&&tool.kind==='MCP');
    const result=tool.kind==='MCP'
      ?await service.validateMcp({asset,tool,archive,arguments:testInput.value as Record<string,unknown>,headers:injection.headers,environment,signal,
        ...(migrated?{service:{start:generated?.start,prepare:generated?.prepare}}:{endpoint:p.endpoint??''})})
      :await service.validateScript({asset,archive,tool,request:testInput.value,context:injection.context,signal});
    result.inputSource=testInput.source;result.inputFields=testInput.fields;
    if(runtimeDeps.length){
      result.runtimeConfigurationDigest=configurationDigest(runtimeConfig,value.sourceInspection?.dependencyAnalysis?.dependencies);
      if(Object.keys(environment).length||Object.keys(injection.headers).length||Object.keys(injection.context).length){result.error=result.status==='PASSED'?null:'工具试运行未通过，请检查测试配置、接口权限和实现。原始错误未保存，以避免泄露运行依赖。';result.stages=result.stages.map(stage=>stage.passed?stage:{...stage,message:'此步骤未通过，原始错误未保存以保护运行依赖。'})}
      await runtimeStore.check(id,{toolId:tool.toolId,kind:value.candidate?'GENERATED_TOOL':'SOURCE_TOOL',status:result.status,configurationDigest:result.runtimeConfigurationDigest,assetDigest:asset.artifactSha256,validationId:result.validationId,message:result.status==='PASSED'?'实际工具调用通过；尚未完成业务效果评估。':'实际工具调用未通过。'});
    }
    (value.technicalValidations??=[]).push(result);await this.projects.save(value);return result;
  });}
  async technicalValidations(id:string){return (await this.get(id)).technicalValidations??[];}
  private async currentTechnicalState(value:MigrationProject){
    const asset=value.candidate??value.source,inspection=value.inspection;
    if(!inspection)return {ready:false,reasons:['请先完成 Tool 检查']};
    const latest=new Map<string,TechnicalValidation>(),runtimeDigest=configurationDigest(await new MigrationRuntimeConfig(this.root).get(value.id),value.sourceInspection?.dependencyAnalysis?.dependencies);
    for(const result of value.technicalValidations??[])if(result.assetDigest===asset.artifactSha256&&(!result.runtimeConfigurationDigest||result.runtimeConfigurationDigest===runtimeDigest))latest.set(result.toolId,result);
    const reasons=inspection.tools.flatMap(tool=>latest.get(tool.toolId)?.status==='PASSED'?[]:[`${tool.name} 尚未通过当前资产的技术验证`]);
    return {ready:reasons.length===0,reasons};
  }
  async validateOpenJiuwen(id:string,input:unknown){
    const value=await this.get(id),state=await this.currentTechnicalState(value);
    if(value.inspection?.skill.status!=='COMPLIANT')return conflict('OpenJiuwen 验证被阻止：当前 Skill 尚未通过企业规范检查');
    if(!state.ready)return conflict(`OpenJiuwen 验证被阻止：${state.reasons.join('；')}`);
    const body=input as {configuration?:{runtime?:{type?:string;environmentId?:string}}};
    const selectedRuntime=body?.configuration?.runtime;
    if(!selectedRuntime||selectedRuntime.type!=='runtime_launcher')return conflict('OpenJiuwen 验证必须选择 Runtime Launcher');
    const environmentId=selectedRuntime.environmentId;
    const environment=environmentId?await this.migrationEnvironment(environmentId):null;
    if(!environment||environment.type!=='runtime_launcher'||environment.runtimeType!=='openjiuwen')return conflict('目标必须是已配置的 OpenJiuwen Runtime Launcher');
    const inspection=value.inspection!,asset=value.candidate??value.source,archive=await this.skills.readArchive(asset.assetId);
    const scripts=inspection.tools.filter(tool=>tool.kind==='SCRIPT'&&tool.entrypoint)
      .map(tool=>{const entry=tool.entrypoint!.path!.replaceAll('\\','/');let root=entry.split('/').slice(0,-1).join('/'),cursor=root;
        while(true){const prefix=cursor?`${cursor}/`:'';if(archive[`${prefix}pyproject.toml`]||archive[`${prefix}package.json`]){root=cursor;break;}if(!cursor)break;cursor=cursor.split('/').slice(0,-1).join('/');}
        const filePaths=Object.keys(archive).filter(name=>(!root||name.startsWith(`${root}/`))&&/\.(?:py|js|mjs|cjs|json|toml|lock)$/iu.test(name));
        return {name:tool.name,path:entry,kind:tool.entrypoint!.kind,filePaths,
          launch:tool.entrypoint!.kind==='PYTHON'?pythonCommand(archive,entry):{program:'node',args:[entry]},
          ...(tool.inputSchema?{inputSchema:tool.inputSchema}:{})};});
    const services:Array<{assetDigest:string;toolNames:string[];filePaths:string[];start:string[];prepare?:string[];environmentReference?:{migrationId:string;revision:number;assetDigest:string;configurationDigest:string}}>=[];
    for(const generation of value.portableGenerations??[]){
      if(generation.form!=='MCP')continue;
      if(!generation.start?.length)return conflict(`候选 MCP ${generation.toolName} 缺少启动命令`);
      const existing=services.find(service=>JSON.stringify([service.start,service.prepare])===JSON.stringify([generation.start,generation.prepare]));
      if(existing){existing.toolNames.push(generation.toolName);existing.filePaths=[...new Set([...existing.filePaths,...generation.files])];}
      else services.push({assetDigest:asset.artifactSha256,toolNames:[generation.toolName],filePaths:generation.files,start:generation.start,...(generation.prepare?{prepare:generation.prepare}:{})});
    }
    const config=await new MigrationRuntimeConfig(this.root).get(id);
    const deps=value.sourceInspection?.dependencyAnalysis?.dependencies??[];
    for(const service of services){
      const toolIds=inspection.tools.filter(tool=>service.toolNames.includes(tool.name)).map(tool=>tool.toolId);
      const serviceDeps=deps.filter(dep=>dep.toolIds.some(id=>toolIds.includes(id))&&dep.binding?.kind==='SERVICE_ENV');
      serviceEnvironment(serviceDeps,config.values);
      if(serviceDeps.length)service.environmentReference={migrationId:id,revision:config.revision,assetDigest:asset.artifactSha256,configurationDigest:configurationDigest(config,deps)};
    }
    const comparison=(body.configuration as Record<string,unknown>).evaluationMode==='service_comparison';
    if(runtimeBuildRequirements(value.sourceInspection??inspection))return conflict('检测到 Runtime Harness 改造需求；自动 Runtime Builder 功能开发中，当前版本暂不能执行对比评测');
    const normalized={...(input as Record<string,unknown>),configuration:{...(body.configuration as Record<string,unknown>),runtimeCommandBindings:{left:comparison?[]:scripts,right:scripts},runtimeMcpBindings:{left:comparison?[]:services,right:services},...(deps.some(d=>d.owner==='RUNTIME'&&d.action==='INJECT')?{runtimeToolConfig:migrationExecutionConfig(deps,config.values,inspection.tools)}:{})}};
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
    if(p.environmentId){const env=await this.migrationEnvironment(p.environmentId);
      if(!env||env.type!=='runtime_launcher'||env.runtimeType!=='openjiuwen')return conflict('目标必须是已配置的 OpenJiuwen Runtime Launcher');}
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
    await this.projects.save(value);return value;
  });}
  async candidate(id:string,input:unknown) {return this.serial(id,async()=>{
    const p=candidateSchema.parse(input), value=await this.get(id), candidate=await this.skills.get(p.assetId);
    if (!candidate || candidate.artifactSha256===value.source.artifactSha256) return conflict('请作为独立的新版本候选导入；源资产保持不变');
    if (candidate.version===value.source.version) return conflict('候选必须使用新的版本号');
    value.candidate=candidate; value.candidateNotes=p.notes;
    delete value.inspection;value.decisions=[];delete value.portableGenerations;delete value.portableGenerationDiff;
    (value.candidateHistory??=[]).push({asset:candidate,notes:p.notes,recordedAt:new Date().toISOString()});
    await this.projects.save(value); return value;
  });}
  async draft(id:string,input:unknown) {return this.serial(id,async()=>{
    const p=draftSchema.parse(input), value=await this.get(id), base=value.candidate??value.source;
    if (p.baseAssetId!==base.assetId) return conflict('候选已变化，请刷新后再编辑');
    const files=await this.skills.readArchive(base.assetId);
    files[base.skillFile]=strToU8(p.autoVersion?versionedMethod(p.source,base.skillId,`0.1.0-migration.${(value.candidateHistory?.length??0)+1}`):p.source);
    const candidate=await this.skills.uploadZip(Buffer.from(zipSync(files)));
    if (candidate.version==='0.0.0-upload' || candidate.version===base.version || candidate.version===value.source.version)
      return conflict('保存前请在 Skill 元数据里写明新的版本号');
    if (candidate.skillId!==base.skillId) return conflict('方法内容的修改不能悄悄改变 Skill 身份');
    value.candidate=candidate;value.candidateNotes=p.notes;
    (value.candidateHistory??=[]).push({asset:candidate,notes:p.notes,recordedAt:new Date().toISOString()});
    await this.projects.save(value);return value;
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
    await this.projects.save(value);return value;
  });}
  async createSuite(id:string,input:unknown) {return this.suiteService.create(id,input);}
  async importSimpleSuite(id:string,input:unknown){return this.suiteService.importSimple(id,input);}
  async generateSuite(id:string,input:unknown) {return this.suiteService.generate(id,input);}
  async optimize(id:string,input:unknown) {return this.serial(id,async()=>{
    const p=z.strictObject({jobId:z.string().min(1)}).parse(input),value=await this.get(id);
    if (!this.optimizers || !value.candidate) return conflict('优化器或候选不可用');
    if(value.generation)return conflict('生成候选需先完成原生迁移验证；当前 Host 适配验收尚未完成，暂不进入表达优化');
    const experiment=value.runs.find(r=>r.jobId===p.jobId);
    if (!experiment || experiment.candidateDigest!==value.candidate.artifactSha256) return conflict('请为当前候选选择一次运行记录');
    if(value.schemaVersion==='finance.skill-migration.v2'){
      const technical=await this.currentTechnicalState(value);if(!technical.ready)return conflict(`请先完成当前 Tool 技术验证：${technical.reasons.join('；')}`);
      const selectedRuntime=experiment.declaredPlan?.configuration.runtime;
      const environmentId=selectedRuntime?.type==='runtime_launcher'?selectedRuntime.environmentId:null;
      const environment=environmentId?await this.migrationEnvironment(environmentId):null;
      if(!environment||environment.runtimeType!=='openjiuwen')return conflict('请先完成当前候选的本地 OpenJiuwen 评估');
    }
    if(value.sourceInspection?.dependencyAnalysis?.dependencies.some(d=>d.owner==='RUNTIME'&&d.action==='INJECT')&&experiment.runtimeConfigurationDigest!==configurationDigest(await new MigrationRuntimeConfig(this.root).get(id),value.sourceInspection.dependencyAnalysis.dependencies))return conflict('运行配置已变化，请重新评估后再优化');
    const job=this.jobs.get(p.jobId),variant=job?.report?.variants.right;
    if (variant?.mode!=='skill_version' || variant.artifactSha256!==value.candidate.artifactSha256) return conflict('缺少已完成的右侧候选运行证据');
    const item=await this.optimizers.create(p.jobId);
    (value.optimizations??=[]).push({optimizationId:item.optimizationId,sourceJobId:p.jobId,baseAssetId:value.candidate.assetId,candidateDigest:value.candidate.artifactSha256});
    await this.projects.save(value);return item;
  });}
  async adoptOptimization(id:string,input:unknown) {return this.serial(id,async()=>{
    const p=z.strictObject({optimizationId:z.string().min(1)}).parse(input),value=await this.get(id);
    const link=value.optimizations?.find(o=>o.optimizationId===p.optimizationId);
    if (!link || !this.optimizers || value.candidate?.assetId!==link.baseAssetId) return conflict('这次优化与当前候选无关，或它的基线候选已变化');
    const item=await this.optimizers.get(p.optimizationId);
    if (!item.candidate || !['review','adopted'].includes(item.status)) return conflict('优化候选必须先跑完复测才能采用');
    await this.skills.readArchive(item.candidate.assetId);
    value.candidate=item.candidate;value.candidateNotes=`Optimization ${item.optimizationId}: ${item.summary}`;
    (value.candidateHistory??=[]).push({asset:item.candidate,notes:value.candidateNotes,recordedAt:new Date().toISOString(),kind:'optimization'});
    // Adoption is a local candidate choice, not migration or business acceptance.
    await this.projects.save(value);return value;
  });}
  async validate(id:string,input:unknown) {return this.serial(id,async()=>{
    const p=planSchema.parse(input), value=await this.get(id), c=value.candidate;
    if (!c || !p.configuration.runtimeBindings) return conflict('缺少候选或左右两侧的绑定');
    if(p.configuration.runtime.type!=='runtime_launcher')return conflict('Skill 迁移评测必须使用 Runtime Launcher');
    const launcherEnvironmentId=p.configuration.runtime.environmentId;
    if((['left','right'] as const).some(side=>p.configuration.runtimeBindings![side].environmentId!==launcherEnvironmentId))return conflict('左右执行绑定必须属于所选 Runtime Launcher');
    let pack=p.configuration.packId ? this.catalog.get(p.configuration.packId):null;
    if (p.configuration.preparationId) {
      if (!value.suiteIds?.includes(p.configuration.preparationId)) return conflict('请选择属于本次迁移的冻结测试集');
      const preparation=await this.preparations?.get(p.configuration.preparationId);
      if (preparation) pack=this.preparations!.buildPack({preparation,analyzerModel:configuredModelRole('ANALYZER').model,
        executionModel:p.configuration.executionModel!,judgeModel:configuredModelRole('JUDGE').model});
    }
    if (!pack || p.configuration.includeHoldout) return conflict('请选择一个冻结的开发题集；留出题留给独立复评');
    const serviceComparison=p.pair==='SC'&&p.configuration.evaluationMode==='service_comparison';
    if((p.pair==='SC')!==(p.configuration.evaluationMode==='service_comparison'))return conflict('原服务对比必须使用 SC 对比计划');
    if(pack.metadata.assessmentMode==='natural_language'&&(!(serviceComparison||(p.pair==='BC'&&p.configuration.evaluationMode==='candidate_assessment'))||p.configuration.judgeMode!=='model'))return conflict('自然语言测试集仅用于目标评估或原服务对比');
    if(serviceComparison&&pack.metadata.assessmentMode!=='natural_language')return conflict('原服务对比请选择包含任务输入和验收要求的测试集');
    if(pack.metadata.comparisonOnly==='true'&&!serviceComparison)return conflict('这份测试集以原服务为基线，请选择原服务对比；目标评估需另外提供独立验收要求');
    const expected=p.pair==='AB' ? [value.source,c] : p.pair==='BC' ? [c,c] : [value.source,c];
    for (const [index,side] of (['left','right'] as const).entries()) {
      const binding=p.configuration.runtimeBindings[side], variant=p.configuration[side==='left'?'leftVariant':'rightVariant'];
      const asset=expected[index]!;
      if (binding.skillAssetId!==asset.assetId || variant?.mode!=='skill_version' || variant.artifactSha256!==asset.artifactSha256
          || variant.skillId!==asset.skillId || variant.version!==asset.version) return conflict('左右绑定与冻结的源/候选不一致');
    }
    if(p.pair==='BC'&&p.configuration.evaluationMode!=='candidate_assessment')return conflict('BC 是对迁移候选的质量评估，不是左右胜负比较');
    if (p.pair==='AB' && p.configuration.runtimeBindings.left.environmentId!==p.configuration.runtimeBindings.right.environmentId) return conflict('AB 对照必须保持原 Runtime 环境一致');
    const runtimeConfigurationDigest=configurationDigest(await new MigrationRuntimeConfig(this.root).get(id),value.sourceInspection?.dependencyAnalysis?.dependencies);
    const comparisonFingerprint=fingerprint({runtimeConfigurationDigest,pack:pack.packFingerprint, model:p.configuration.executionModel,
      cases:p.configuration.selectedCaseIds, data:p.dataSnapshot, permissions:p.permissionBasis,
      sourceProject:p.sourceProjectRef, lock:p.dependencyLockRef,evaluationMode:p.configuration.evaluationMode,
      ...(p.configuration.originalService?{originalService:originalServiceFingerprint(p.configuration.originalService)}:{})});
    const job=await this.runs.create(p.configuration);
    value.runs.push({jobId:job.jobId,pair:p.pair,candidateDigest:c.artifactSha256,comparisonFingerprint,packFingerprint:pack.packFingerprint,declaredPlan:p,suiteSnapshot:pack,runtimeConfigurationDigest});
    await this.projects.save(value);
    return {job,comparisonFingerprint,acceptance:'NOT_VALIDATED',note:'Runs are experiments; declared environment/material references are not native-runtime or authorization attestation.'};
  });}
  async report(id:string) {
    const value=await this.get(id);
    const runtimeInspection=value.sourceInspection??value.inspection;
    const runtimeRequirements=runtimeInspection?runtimeBuildRequirements(runtimeInspection):null;
    const diagnosis=this.diagnostics?await this.diagnostics.diagnose(value.source):null;
    const targetRunner=new MigrationTargetRuns(this.root,this.skills);
    const targetRuns=await Promise.all((value.targetRuns??[]).map(runId=>targetRunner.get(runId)));
    const current=targetRuns.filter(r=>r.candidateDigest===value.candidate?.artifactSha256).at(-1);
    const currentAsset=value.candidate??value.source;
    const runtimeDigest=configurationDigest(await new MigrationRuntimeConfig(this.root).get(id),value.sourceInspection?.dependencyAnalysis?.dependencies);
    const technicalValidations=(value.technicalValidations??[]).map(result=>({...result,current:result.assetDigest===currentAsset.artifactSha256&&(!result.runtimeConfigurationDigest||result.runtimeConfigurationDigest===runtimeDigest)}));
    const migrationPlan=value.inspection?buildMigrationPlan(value.inspection,value.decisions??[],value.inspection.assetId):null;
    const experiments=value.runs.map(r=>{
      const job=this.jobs.get(r.jobId);
      const complete=job?.status==='completed' && !!job.report?.cases.length && job.report.cases.every(c=>(['left','right'] as const).every(side=>{
        if(side==='left'&&r.declaredPlan?.configuration.evaluationMode==='service_comparison'){
          const service=c.left.metadata.baselineService as {configurationFingerprint?:string;sourceDigest?:string;responseDigest?:string}|undefined;
          return c.left.status==='completed'&&c.left.streamCompleted&&service?.sourceDigest===value.source.artifactSha256
            &&!!service.responseDigest&&service.configurationFingerprint===originalServiceFingerprint(r.declaredPlan.configuration.originalService!);
        }
        const variant=job.configuration[side==='left'?'leftVariant':'rightVariant'];
        return c[side].status==='completed' && variant?.mode==='skill_version' && !!variant.artifactSha256
          && c[side].metadata.skillArtifactSha256===variant.artifactSha256;
      }));
      const selected=r.declaredPlan?.configuration.selectedCaseIds??[];
      const acceptance=assessMigrationAcceptance(job?.report??null,(r.suiteSnapshot?.cases??[]).filter(item=>!selected.length||selected.includes(item.caseId)),complete);
      return {...r,current:r.candidateDigest===currentAsset.artifactSha256&&(!value.sourceInspection?.dependencyAnalysis?.dependencies.some(d=>d.owner==='RUNTIME'&&d.action==='INJECT')||r.runtimeConfigurationDigest===runtimeDigest),execution:job?.status??'MISSING',createdAt:job?.createdAt,updatedAt:job?.updatedAt,report:job?.report??null,error:job?.error??null,evidence:complete?(r.pair==='SC'?'SERVICE_BASELINE_AND_CANDIDATE_DIGEST_CHECKED':'HTTP_LOADED_DIGEST_CHECKED'):'NOT_COMPLETE',acceptance,
        taskSuccess:'NOT_INDEPENDENTLY_VERIFIED',professionalAcceptance:'NOT_REVIEWED',migrationAcceptance:'NOT_VALIDATED'};
    });
    const openJiuwenValidations=(await Promise.all(experiments.map(async experiment=>{
      const runtime=experiment.declaredPlan?.configuration.runtime;
      const environment=runtime&&(runtime.type==='runtime_http'||runtime.type==='runtime_launcher')?await this.migrationEnvironment(runtime.environmentId):null;
      if(!environment||!['runtime_http','runtime_launcher'].includes(environment.type)||environment.runtimeType!=='openjiuwen')return null;
      return {jobId:experiment.jobId,candidateDigest:experiment.candidateDigest,environmentId:environment.environmentId,
        execution:experiment.execution,evidence:experiment.evidence,current:experiment.current,
        executionCheck:['HTTP_LOADED_DIGEST_CHECKED','SERVICE_BASELINE_AND_CANDIDATE_DIGEST_CHECKED'].includes(experiment.evidence)?'ARTIFACT_VERIFIED':experiment.execution==='completed'?'EXECUTION_COMPLETED':'NOT_COMPLETE',
        acceptance:experiment.acceptance,
        status:experiment.execution==='completed'?experiment.acceptance.status:experiment.execution==='failed'?'FAILED':['queued','preparing','running','judging'].includes(experiment.execution)?'RUNNING':'NOT_VALIDATED'};
    }))).filter(item=>item!==null);
    const currentOpenJiuwen=openJiuwenValidations.filter(item=>item.current).at(-1);
    const targetExecution=value.schemaVersion==='finance.skill-migration.v2'?(currentOpenJiuwen?.status??'NOT_RUN'):(current?.status??'NOT_RUN');
    const originalBaseline=experiments.filter(r=>r.pair==='SC'&&r.current).at(-1);
    return {project:value,diagnosis,inspection:value.inspection??null,decisions:value.decisions??[],migrationPlan,runtimeRequirements,portableGenerationDiff:value.portableGenerationDiff??[],technicalValidations,openJiuwenValidations,targetRuns,professionalReview:value.reviews?.filter(r=>r.candidateDigest===value.candidate?.artifactSha256).at(-1)??null,verification:{originalBaseline:originalBaseline?.evidence==='SERVICE_BASELINE_AND_CANDIDATE_DIGEST_CHECKED'?'CAPTURED':originalBaseline?'NOT_COMPLETE':'NOT_RUN',targetExecution,
      candidateChanged:!!value.generation&&value.generation.candidateDigest!==value.candidate?.artifactSha256,
      originalOwner:'原工程负责人',targetOwner:'Harness / Host 接入开发者',
      missingSource:diagnosis?.findings.filter(f=>f.layer==='UNKNOWN').map(f=>({path:f.path,line:f.line,reason:f.reason}))??[],
      targetGaps:value.simulationProfile?['本目标只验证方法在模拟业务端口上的执行，不证明原环境等价或专业结论正确。','原工程、原环境对照与业务口径仍待负责人确认。']:[targetExecution==='PASSED'?'当前候选通过自动验收，但原环境对照与人类专业签署尚未完成':'当前候选尚未通过完整业务验收，请查看工具调用证据、必备规则和质量评分',
        '需冻结等价测试数据与可信身份范围；配置声明不等于授权已核验']},
      suites:await Promise.all((value.suiteIds??[]).map(id=>this.preparations?.get(id)??null)),
      optimizations:await Promise.all((value.optimizations??[]).map(async link=>({...link,item:await this.optimizers?.get(link.optimizationId)}))),
      experiments, attribution:'BC compares target execution stacks, including Harness; not a pure Runtime effect.'};
  }
  async exportCandidate(id:string) {
    const value=await this.get(id);
    if (!value.candidate) return conflict('请先生成候选');
    const files=await this.skills.readArchive(value.candidate.assetId);
    if (['migration-manifest.json','migration-report.json'].some(name=>name in files)) return conflict('候选里已存在导出要用的元数据路径，未覆盖任何文件');
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
  release():never {return conflict('发布已阻止：原环境基线、目标 Host 接入、依赖验证与独立业务验收都还没有验证');}
}
