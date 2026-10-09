import { randomUUID } from "node:crypto";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { KeyedQueue } from "../shared/keyed-queue.js";
import { preflightMcpServer, type McpPreflightResult } from "../mcp-preflight.js";
import {
  createEnvironmentSchema,
  environmentArchiveSchema,
  environmentRecordSchema,
  type EnvironmentRecord,
} from "../shared/contracts/environment.js";
import { ensureDirectory, listJsonFiles, readJson, writeJsonAtomic } from "./file-store.js";
import { RuntimeLauncherAdapter, runtimeLauncherCapabilitiesSchema, type RuntimeLauncherCapabilities } from '../runtime-launcher.js';
import { runtimeBuildRequirementsSchema, runtimeBuildResultSchema, validateRuntimeBuildResult } from '../shared/contracts/runtime-builder.js';
import {nativeToolCatalogSchema} from '../shared/contracts/native-tool-catalog.js';
import {readBoundedJson} from '../runtime-launcher.js';
import type {ResolvedSkillSource} from '../direct-model-runtime.js';
import type {SkillVariant} from '../contracts.js';

function headersFor(record: EnvironmentRecord): Record<string, string> {
  if(record.type==='execution_environment')return {};
  if (!record.credentialEnv) return {};
  const credential = process.env[record.credentialEnv];
  if (!credential) throw new Error(`Credential environment variable is unavailable: ${record.credentialEnv}`);
  return { authorization: credential.startsWith("Bearer ") ? credential : `Bearer ${credential}` };
}
function requireNotArchived(record: EnvironmentRecord): void {
  if(record.archived)throw Object.assign(new Error('Environment is archived'),{statusCode:409,code:'ENVIRONMENT_ARCHIVED'});
}
export class EnvironmentStore {
  private readonly directory: string;
  private readonly writes = new KeyedQueue();

  constructor(dataDirectory: string,private readonly launcherTrust:Array<{reference:string;label:string;baseUrlPrefix:string;credentialEnv:string|null}>=[]) {
    this.directory = path.join(dataDirectory, "environments");
  }

  async initialize(): Promise<void> {
    await ensureDirectory(this.directory);
  }

  async nativeToolCatalog(environmentId:string){
    const record=await this.requireAvailable(environmentId);
    if(record?.type!=='runtime_launcher')throw Object.assign(new Error('请选择已登记的原生 Runtime Launcher'),{statusCode:409});
    const response=await fetch(new URL('v1/native-tool-catalog',record.baseUrl),{
      headers:headersFor(record),redirect:'error',signal:AbortSignal.timeout(10000),
    });
    if(!response.ok)throw Object.assign(new Error('此环境尚未配置已准入工具合同目录'),{statusCode:409});
    const catalog=nativeToolCatalogSchema.parse(await readBoundedJson(response,1_048_576,'Native tool catalog'));
    if(catalog.runtime.type!==record.runtimeType)throw Object.assign(new Error('工具目录与登记的 Runtime 不一致'),{statusCode:409});
    return {environmentId,catalog};
  }

  async list(options: {includeArchived?: boolean} = {}): Promise<EnvironmentRecord[]> {
    const records = await Promise.all(
      (await listJsonFiles(this.directory)).map(file => readJson<EnvironmentRecord>(file)),
    );
    // Unsupported legacy registrations remain on disk for historical references.
    return records.filter(record => (record as {type:string}).type !== 'runtime_http')
      .map(record => environmentRecordSchema.parse(record))
      .filter(record => options.includeArchived === true || !record.archived)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(environmentId: string): Promise<EnvironmentRecord | null> {
    if (!/^[a-z0-9-]+$/u.test(environmentId)) return null;
    try {
      const record = await readJson<{type?:string}>(path.join(this.directory, `${environmentId}.json`));
      if(record.type==='runtime_http')return null;
      return environmentRecordSchema.parse(record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async setArchived(environmentId: string, input: unknown): Promise<EnvironmentRecord> {
    const {archived} = environmentArchiveSchema.parse(input);
    return this.writes.run('registry', async () => {
      const previous = await this.get(environmentId);
      if(!previous)throw Object.assign(new Error('Environment not found'),{statusCode:404});
      if(previous.archived === archived)return previous;
      const record = environmentRecordSchema.parse({...previous,archived,updatedAt:new Date().toISOString()});
      await writeJsonAtomic(path.join(this.directory,`${environmentId}.json`),record);
      return record;
    });
  }

  /** Fresh admission lookup. get() deliberately remains usable for historical references. */
  async requireAvailable(environmentId: string): Promise<EnvironmentRecord> {
    const record = await this.get(environmentId);
    if(!record)throw Object.assign(new Error('Environment not found'),{statusCode:404});
    requireNotArchived(record);
    if(record.type==='execution_environment')await this.validateExecutionEnvironment(record.launcherEnvironmentId,record.mcpEnvironmentIds);
    return record;
  }

  async create(input: unknown): Promise<EnvironmentRecord> {
    return this.writes.run("registry", async () => {
    const parsed = createEnvironmentSchema.parse(input);
    if(parsed.type==='execution_environment')await this.validateExecutionEnvironment(parsed.launcherEnvironmentId,parsed.mcpEnvironmentIds);
    const now = new Date().toISOString();
    const record = environmentRecordSchema.parse({
      ...parsed,
      runtimeType: parsed.type === 'runtime_launcher'?parsed.runtimeType:null,
      ...('credentialEnv' in parsed?{credentialEnv:parsed.credentialEnv??null}:{}),
      ...(parsed.type==='execution_environment'?{defaultModelId:parsed.defaultModelId??null}:{}),
      environmentId: `env-${randomUUID().slice(0, 12)}`,
      createdAt: now,
      updatedAt: now,
    });
    await writeJsonAtomic(path.join(this.directory, `${record.environmentId}.json`), record);
    return record;
    });
  }

  async acceptBuilderDelivery(input:{requirements:unknown;result:unknown;trustReference:string;name?:string;
    conformance?:{skill:ResolvedSkillSource;requiredTools:string[]}}):Promise<{
    environment:Extract<EnvironmentRecord,{type:'runtime_launcher'}>;capabilities:RuntimeLauncherCapabilities;created:boolean;
  }>{
    const requirements=runtimeBuildRequirementsSchema.parse(input.requirements);
    const result=runtimeBuildResultSchema.parse(input.result);
    const launcher=result.launcher;
    if(!launcher)throw Object.assign(new Error('Builder 没有返回可用的 Runtime Launcher。'),{statusCode:400});
    const registered=(await this.list({includeArchived:true})).find(record=>record.type==='runtime_launcher'&&record.delivery?.deploymentId===launcher.deploymentId);
    if(registered)requireNotArchived(registered);
    if(launcher.expiresAt&&Date.parse(launcher.expiresAt)<=Date.now())throw Object.assign(new Error('Builder 返回的 Runtime Launcher 已过期。'),{statusCode:400});
    const trust=this.launcherTrust.find(item=>item.reference===input.trustReference);
    if(!trust)throw Object.assign(new Error('Launcher 信任引用不存在或未由服务端配置。'),{statusCode:400});
    const trustedPrefix=new URL(trust.baseUrlPrefix);const deliveredUrl=new URL(launcher.baseUrl);
    const prefixPath=trustedPrefix.pathname.endsWith('/')?trustedPrefix.pathname:`${trustedPrefix.pathname}/`;
    if(deliveredUrl.origin!==trustedPrefix.origin||!deliveredUrl.pathname.startsWith(prefixPath)){
      throw Object.assign(new Error('Builder 返回的 Launcher 地址不属于信任引用允许的目标。'),{statusCode:400});
    }
    const credentialEnv=trust.credentialEnv;
    let authorization:string|undefined;
    if(launcher.authentication.type==='bearer'){
      if(!credentialEnv)throw Object.assign(new Error('该 Launcher 要求 Bearer 凭据，但信任引用没有配置专用凭据。'),{statusCode:400});
      const credential=process.env[credentialEnv];
      if(!credential)throw Object.assign(new Error(`凭据环境变量不可用: ${credentialEnv}`),{statusCode:400});
      authorization=credential.startsWith('Bearer ')?credential:`Bearer ${credential}`;
    }else if(credentialEnv){
      throw Object.assign(new Error('该 Launcher 声明无需认证，但信任引用绑定了凭据。'),{statusCode:400});
    }
    let capabilities:RuntimeLauncherCapabilities;
    let conformanceError:Error|null=null;
    try{
      const response=await fetch(new URL('v1/runtime-capabilities',launcher.baseUrl),{
        headers:authorization?{authorization}:{},redirect:'error',signal:AbortSignal.timeout(10_000),
      });
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      capabilities=runtimeLauncherCapabilitiesSchema.parse(await response.json());
    }catch(error){
      throw Object.assign(new Error(`无法验证 Builder 返回的 Launcher: ${error instanceof Error?error.message:String(error)}`),{statusCode:400});
    }
    const issues=validateRuntimeBuildResult(requirements,result,capabilities);
    if(issues.length)throw Object.assign(new Error(`Builder 交付未通过验收: ${issues.join(', ')}`),{statusCode:400,issues});
    const headers:Record<string,string>=authorization?{authorization}:{};
    const model=capabilities.models.find(item=>item.modelId===capabilities.defaultModelId)!;
    const skill=input.conformance?.skill??null;
    const variant:SkillVariant=skill?{mode:'skill_version',skillId:skill.skillId,version:skill.version,artifactSha256:skill.artifactSha256}
      :{mode:'without_target_skill',skillId:'finance-eval-conformance'};
    const requiredTools=input.conformance?.requiredTools??[];
    const probeFiles=!skill||requiredTools.includes('read_case_file');
    const adapter=new RuntimeLauncherAdapter({baseUrl:launcher.baseUrl,headers,side:'right',model:{providerId:'launcher-conformance',modelId:model.modelId,parameters:{}},
      variant,skill,environment:{environmentId:`conformance-${launcher.deploymentId}`,requiredToolNames:requiredTools},configuration:{},secrets:{mode:'inline',values:{}},timeoutMs:Math.min(capabilities.limits.maxTimeoutMs,300_000),requireStatusPoll:true});
    const probeId=`conformance-${randomUUID()}`;
    try{
      await adapter.prepare({runId:probeId});
      const evidence=await adapter.execute({runId:probeId,side:'right',model:{providerId:'launcher-conformance',modelId:model.modelId,parameters:{}},variant,evalCase:{caseId:'launcher-lifecycle',name:'Launcher lifecycle conformance',taskMode:'single_turn',prompt:probeFiles?'仅核验案例文件：读取 conformance/probe.txt 并返回其内容。不要办理业务。':'这是生命周期连通检查，请只回复 CONFORMANCE_OK，不调用业务工具。',evaluationGoal:'Verify the complete Launcher lifecycle.',requiredTools,workspaceFiles:probeFiles?[{path:'conformance/probe.txt',content:'CONFORMANCE_OK'}]:[],rubric:[{criterionId:'lifecycle',label:'Lifecycle',description:'Launcher completed the isolated lifecycle.',dimension:'business_completeness',weight:1,required:true,allOf:['CONFORMANCE_OK'],anyOf:[],noneOf:[]}]}});
      if(evidence.status!=='completed'||!evidence.runtimeIdentityVerified||!evidence.streamCompleted||!evidence.output.includes('CONFORMANCE_OK'))throw new Error(evidence.error??'Launcher conformance execution did not complete with the mounted probe data');
      if(skill&&probeFiles&&!evidence.toolCalls.some(call=>call.name==='read_case_file'&&call.status==='completed'))throw new Error('Lifecycle probe did not execute the declared file tool');
    }catch(error){conformanceError=error instanceof Error?error:new Error(String(error));}
    try{await adapter.cleanup();}catch(error){conformanceError=new Error(`${conformanceError?`${conformanceError.message}; `:''}实例清理失败: ${error instanceof Error?error.message:String(error)}`);}
    if(conformanceError)throw Object.assign(new Error(`Launcher 生命周期验收失败: ${conformanceError.message}`),{statusCode:400});
    return this.writes.run('registry',async()=>{
      const existing=(await this.list({includeArchived:true})).find((record):record is Extract<EnvironmentRecord,{type:'runtime_launcher'}>=>record.type==='runtime_launcher'&&record.delivery?.deploymentId===launcher.deploymentId);
      if(existing){
        requireNotArchived(existing);
        if(existing.delivery?.resultDigest!==result.resultDigest||existing.baseUrl!==launcher.baseUrl){
          throw Object.assign(new Error('相同 deploymentId 已登记，但交付摘要或地址不同。'),{statusCode:409});
        }
        // Re-admission has rechecked the contract and lifecycle, including cleanup.
        // Upgrade legacy records only through that same trusted acceptance path.
        if(existing.delivery.requirementsDigest!==requirements.requirementsDigest){
          existing.delivery.requirementsDigest=requirements.requirementsDigest;
          existing.updatedAt=new Date().toISOString();
          await writeJsonAtomic(path.join(this.directory,`${existing.environmentId}.json`),existing);
        }
        return {environment:existing,capabilities,created:false};
      }
      const now=new Date().toISOString();
      const runtimeType=['openjiuwen','agentscope','ea'].includes(launcher.runtime.type)?launcher.runtime.type:'generic_http';
      const environment=environmentRecordSchema.parse({
        environmentId:`env-${randomUUID().slice(0,12)}`,name:input.name?.trim()||`${result.builder.name} · ${launcher.runtime.type}`,
        type:'runtime_launcher',runtimeType,baseUrl:launcher.baseUrl,credentialEnv,createdAt:now,updatedAt:now,
        delivery:{schemaVersion:'finance.runtime-launcher-delivery-record.v1',
          buildId:result.buildId,requestId:result.requestId,requirementsDigest:requirements.requirementsDigest,deploymentId:launcher.deploymentId,
          artifactSha256:launcher.artifactSha256,capabilitiesDigest:launcher.capabilitiesDigest,resultDigest:result.resultDigest,
          builder:result.builder,acceptedAt:now,expiresAt:launcher.expiresAt,
          evalConformance:{status:'PASSED',testedAt:now,checks:['capabilities','create','status','execute','evidence','delete']}},
      }) as Extract<EnvironmentRecord,{type:'runtime_launcher'}>;
      await writeJsonAtomic(path.join(this.directory,`${environment.environmentId}.json`),environment);
      return {environment,capabilities,created:true};
    });
  }

  async rollbackBuilderDelivery(environmentId:string,resultDigest:string):Promise<void>{
    await this.writes.run('registry',async()=>{
      const record=await this.get(environmentId);
      if(record?.type==='runtime_launcher'&&record.delivery?.resultDigest===resultDigest)await unlink(path.join(this.directory,`${environmentId}.json`));
    });
  }

  private async validateBindings(ids: string[]): Promise<void> {
    for (const id of ids) {
      const record = await this.get(id);
      if (!record || record.type !== "mcp_streamable_http") {
        throw Object.assign(new Error(`MCP binding is unavailable: ${id}`), { statusCode: 400 });
      }
      requireNotArchived(record);
    }
  }

  private async validateExecutionEnvironment(launcherId:string,mcpIds:string[]):Promise<void>{
    const launcher=await this.get(launcherId);
    if(!launcher||launcher.type!=='runtime_launcher')throw Object.assign(new Error('Runtime Launcher is unavailable'),{statusCode:400});
    requireNotArchived(launcher);
    await this.validateBindings(mcpIds);
  }

  async resolveLauncher(record:EnvironmentRecord):Promise<{launcher:Extract<EnvironmentRecord,{type:'runtime_launcher'}>;mcpEnvironmentIds:string[];defaultModelId:string|null}>{
    record=await this.requireAvailable(record.environmentId);
    if(record.type==='runtime_launcher')return {launcher:record,mcpEnvironmentIds:[],defaultModelId:null};
    if(record.type!=='execution_environment')throw Object.assign(new Error('Execution environment is unavailable'),{statusCode:400});
    const launcher=await this.requireAvailable(record.launcherEnvironmentId);
    if(!launcher||launcher.type!=='runtime_launcher')throw Object.assign(new Error('Runtime Launcher is unavailable'),{statusCode:400});
    return {launcher,mcpEnvironmentIds:record.mcpEnvironmentIds,defaultModelId:record.defaultModelId};
  }

  async update(id: string, input: unknown): Promise<EnvironmentRecord> {
    return this.writes.run("registry", async () => {
      const previous = await this.get(id);
      if (!previous) throw Object.assign(new Error("Environment not found"), { statusCode: 404 });
      const parsed = createEnvironmentSchema.parse(input);
      if (parsed.type !== previous.type) {
        throw Object.assign(new Error("Resource type cannot change; create a new environment instead"), { statusCode: 409 });
      }
      if(previous.type==='runtime_launcher'&&previous.delivery&&parsed.type==='runtime_launcher'){
        const credentialChanged=Object.prototype.hasOwnProperty.call(parsed,'credentialEnv')&&(parsed.credentialEnv??null)!==previous.credentialEnv;
        if(parsed.baseUrl!==previous.baseUrl||parsed.runtimeType!==previous.runtimeType||credentialChanged){
          throw Object.assign(new Error('Builder 管理的 Runtime Launcher 连接配置不可修改；请提交新的 Builder 交付并重新验收。'),{statusCode:409});
        }
        const record=environmentRecordSchema.parse({...previous,name:parsed.name,updatedAt:new Date().toISOString()});
        await writeJsonAtomic(path.join(this.directory,`${id}.json`),record);
        return record;
      }
      if(parsed.type==='execution_environment')await this.validateExecutionEnvironment(parsed.launcherEnvironmentId,parsed.mcpEnvironmentIds);
      const record = environmentRecordSchema.parse({
        ...previous, ...parsed,
        runtimeType: parsed.type === 'runtime_launcher'?parsed.runtimeType:null,
        ...('credentialEnv' in parsed?{credentialEnv:parsed.credentialEnv??null}:{}),
        ...(parsed.type==='execution_environment'?{defaultModelId:parsed.defaultModelId??null}:{}),
        updatedAt: new Date().toISOString(),
      });
      await writeJsonAtomic(path.join(this.directory, `${id}.json`), record);
      return record;
    });
  }

  async remove(id: string): Promise<void> {
    await this.writes.run("registry", async () => {
      if (!await this.get(id)) throw Object.assign(new Error("Environment not found"), { statusCode: 404 });
      const dependent = (await this.list({includeArchived:true})).find(record => ('mcpEnvironmentIds' in record&&record.mcpEnvironmentIds.includes(id))||
        (record.type==='execution_environment'&&record.launcherEnvironmentId===id));
      if (dependent) throw Object.assign(new Error(`Environment is still bound by ${dependent.name}`), { statusCode: 409 });
      await unlink(path.join(this.directory, `${id}.json`));
    });
  }

  headers(record: EnvironmentRecord): Record<string, string> {
    requireNotArchived(record);
    return headersFor(record);
  }

  async preflight(record: EnvironmentRecord): Promise<McpPreflightResult | {
    status: "ready" | "failed";
    elapsedMs: number;
    error: string | null;
    capabilities?:RuntimeLauncherCapabilities;
  }> {
    record=await this.requireAvailable(record.environmentId);
    if(record.type==='execution_environment'){
      const {launcher,defaultModelId,mcpEnvironmentIds}=await this.resolveLauncher(record);
      const result=await this.preflight(launcher);
      if(result.status!=='ready'||!('capabilities' in result)||!result.capabilities)return result;
      if(defaultModelId&&!result.capabilities.models.some(model=>model.modelId===defaultModelId))return {...result,status:'failed' as const,error:'执行环境默认模型不属于所选 Runtime Launcher'};
      if(mcpEnvironmentIds.length&&!result.capabilities.features.externalMcp)return {...result,status:'failed' as const,error:'所选 Runtime Launcher 不支持动态外部 MCP'};
      return result;
    }
    if(record.type==='runtime_launcher'){
      const startedAt=Date.now();
      try{
        const response=await fetch(new URL('v1/runtime-capabilities',record.baseUrl),{headers:headersFor(record),signal:AbortSignal.timeout(10_000),redirect:'error'});
        if(!response.ok)throw new Error(`HTTP ${response.status}`);
        const capabilities=runtimeLauncherCapabilitiesSchema.parse(await response.json());
        if(record.runtimeType!=='generic_http'&&capabilities.runtime.type!==record.runtimeType)throw new Error('Runtime type does not match the registered Launcher');
        return {status:'ready',elapsedMs:Date.now()-startedAt,error:null,capabilities};
      }catch(error){return {status:'failed',elapsedMs:Date.now()-startedAt,error:error instanceof Error?error.message:String(error)};}
    }
    if (record.type === "mcp_streamable_http") {
      return preflightMcpServer({ endpoint: record.endpoint, headers: headersFor(record) });
    }
    throw new Error(`Unsupported environment type: ${record satisfies never}`);
  }

  async inspect(record: EnvironmentRecord): Promise<{
    status: "ready" | "failed";
    elapsedMs: number;
    error: string | null;
    toolCount: number;
    tools: Array<{ name: string }>;
    mcpServers: Array<{
      environmentId: string;
      name: string;
      status: "ready" | "failed";
      toolNames: string[];
      error: string | null;
    }>;
    capabilities?:RuntimeLauncherCapabilities;
  }> {
    const startedAt = Date.now();
    const primary = await this.preflight(record);
    const nativeTools='capabilities' in primary?primary.capabilities?.nativeToolNames?.map(name=>({name}))??[]:[];
    if(record.type==='runtime_launcher')return {status:primary.status,elapsedMs:Date.now()-startedAt,error:primary.error,toolCount:nativeTools.length,tools:nativeTools,mcpServers:[],...('capabilities' in primary&&primary.capabilities?{capabilities:primary.capabilities}:{})};
    if (record.type === "mcp_streamable_http") {
      const tools = primary.status === "ready" && "tools" in primary ? primary.tools : [];
      return {
        status: primary.status,
        elapsedMs: Date.now() - startedAt,
        error: primary.error,
        toolCount: tools.length,
        tools: tools.map(tool => ({ name: tool.name })),
        mcpServers: [{ environmentId: record.environmentId, name: record.name, status: primary.status, toolNames: tools.map(tool => tool.name), error: primary.error }],
      };
    }

    const mcpServers = [];
    const allTools: Array<{ name: string }> = [...nativeTools];
    const mcpEnvironmentIds='mcpEnvironmentIds' in record?record.mcpEnvironmentIds:[];
    for (const environmentId of mcpEnvironmentIds) {
      const environment = await this.get(environmentId);
      if (!environment || environment.type !== "mcp_streamable_http") {
        mcpServers.push({
          environmentId,
          name: environmentId,
          status: "failed" as const,
          toolNames: [],
          error: "MCP 环境不存在",
        });
        continue;
      }
      const result = await this.preflight(environment);
      const tools = result.status === "ready" && "tools" in result ? result.tools : [];
      allTools.push(...tools.map(tool => ({ name: tool.name })));
      mcpServers.push({
        environmentId,
        name: environment.name,
        status: result.status,
        toolNames: tools.map(tool => tool.name),
        error: result.error,
      });
    }
    const failedMcp = mcpServers.find(item => item.status === "failed");
    return {
      status: primary.status === "ready" && !failedMcp ? "ready" : "failed",
      elapsedMs: Date.now() - startedAt,
      error: primary.error ?? failedMcp?.error ?? null,
      toolCount: allTools.length,
      tools: allTools,
      mcpServers,
      ...('capabilities' in primary&&primary.capabilities?{capabilities:primary.capabilities}:{}),
    };
  }
}
