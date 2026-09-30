import { randomUUID } from "node:crypto";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { KeyedQueue } from "../shared/keyed-queue.js";
import { preflightMcpServer, type McpPreflightResult } from "../mcp-preflight.js";
import {
  createEnvironmentSchema,
  environmentRecordSchema,
  type EnvironmentRecord,
} from "../shared/contracts/environment.js";
import { ensureDirectory, listJsonFiles, readJson, writeJsonAtomic } from "./file-store.js";
import { runtimeLauncherCapabilitiesSchema, type RuntimeLauncherCapabilities } from '../runtime-launcher.js';
import { runtimeBuildRequirementsSchema, runtimeBuildResultSchema, validateRuntimeBuildResult } from '../shared/contracts/runtime-builder.js';

function headersFor(record: EnvironmentRecord): Record<string, string> {
  if(record.type==='execution_environment')return {};
  if (!record.credentialEnv) return {};
  const credential = process.env[record.credentialEnv];
  if (!credential) throw new Error(`Credential environment variable is unavailable: ${record.credentialEnv}`);
  return { authorization: credential.startsWith("Bearer ") ? credential : `Bearer ${credential}` };
}
export class EnvironmentStore {
  private readonly directory: string;
  private readonly writes = new KeyedQueue();

  constructor(dataDirectory: string) {
    this.directory = path.join(dataDirectory, "environments");
  }

  async initialize(): Promise<void> {
    await ensureDirectory(this.directory);
    for(const file of await listJsonFiles(this.directory)){
      const value=await readJson<{type?:unknown}>(file);
      if(value.type==='runtime_http')await unlink(file);
    }
  }

  async list(): Promise<EnvironmentRecord[]> {
    const records = await Promise.all(
      (await listJsonFiles(this.directory)).map(file => readJson<EnvironmentRecord>(file)),
    );
    return records.map(record => environmentRecordSchema.parse(record))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(environmentId: string): Promise<EnvironmentRecord | null> {
    if (!/^[a-z0-9-]+$/u.test(environmentId)) return null;
    try {
      return environmentRecordSchema.parse(
        await readJson(path.join(this.directory, `${environmentId}.json`)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
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

  async acceptBuilderDelivery(input:{migrationId:string;requirements:unknown;result:unknown;credentialEnv?:string|null;name?:string}):Promise<{
    environment:Extract<EnvironmentRecord,{type:'runtime_launcher'}>;capabilities:RuntimeLauncherCapabilities;
  }>{
    const requirements=runtimeBuildRequirementsSchema.parse(input.requirements);
    const result=runtimeBuildResultSchema.parse(input.result);
    const launcher=result.launcher;
    if(!launcher)throw Object.assign(new Error('Builder 没有返回可用的 Runtime Launcher。'),{statusCode:400});
    if(launcher.expiresAt&&Date.parse(launcher.expiresAt)<=Date.now())throw Object.assign(new Error('Builder 返回的 Runtime Launcher 已过期。'),{statusCode:400});
    const credentialEnv=input.credentialEnv?.trim()||null;
    let authorization:string|undefined;
    if(launcher.authentication.type==='bearer'){
      if(!credentialEnv)throw Object.assign(new Error('该 Launcher 要求 Bearer 凭据，请填写保存凭据的环境变量名。'),{statusCode:400});
      const credential=process.env[credentialEnv];
      if(!credential)throw Object.assign(new Error(`凭据环境变量不可用: ${credentialEnv}`),{statusCode:400});
      authorization=credential.startsWith('Bearer ')?credential:`Bearer ${credential}`;
    }else if(credentialEnv){
      throw Object.assign(new Error('该 Launcher 声明无需认证，不应绑定凭据环境变量。'),{statusCode:400});
    }
    let capabilities:RuntimeLauncherCapabilities;
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
    return this.writes.run('registry',async()=>{
      const existing=(await this.list()).find((record):record is Extract<EnvironmentRecord,{type:'runtime_launcher'}>=>record.type==='runtime_launcher'&&record.delivery?.deploymentId===launcher.deploymentId);
      if(existing){
        if(existing.delivery?.resultDigest!==result.resultDigest||existing.baseUrl!==launcher.baseUrl){
          throw Object.assign(new Error('相同 deploymentId 已登记，但交付摘要或地址不同。'),{statusCode:409});
        }
        return {environment:existing,capabilities};
      }
      const now=new Date().toISOString();
      const runtimeType=['openjiuwen','ea'].includes(launcher.runtime.type)?launcher.runtime.type:'generic_http';
      const environment=environmentRecordSchema.parse({
        environmentId:`env-${randomUUID().slice(0,12)}`,name:input.name?.trim()||`${result.builder.name} · ${launcher.runtime.type}`,
        type:'runtime_launcher',runtimeType,baseUrl:launcher.baseUrl,credentialEnv,createdAt:now,updatedAt:now,
        delivery:{schemaVersion:'finance.runtime-launcher-delivery-record.v1',migrationId:input.migrationId,
          buildId:result.buildId,requestId:result.requestId,deploymentId:launcher.deploymentId,
          artifactSha256:launcher.artifactSha256,capabilitiesDigest:launcher.capabilitiesDigest,resultDigest:result.resultDigest,
          builder:result.builder,acceptedAt:now,expiresAt:launcher.expiresAt},
      }) as Extract<EnvironmentRecord,{type:'runtime_launcher'}>;
      await writeJsonAtomic(path.join(this.directory,`${environment.environmentId}.json`),environment);
      return {environment,capabilities};
    });
  }

  private async validateBindings(ids: string[]): Promise<void> {
    for (const id of ids) {
      const record = await this.get(id);
      if (!record || record.type !== "mcp_streamable_http") {
        throw Object.assign(new Error(`MCP binding is unavailable: ${id}`), { statusCode: 400 });
      }
    }
  }

  private async validateExecutionEnvironment(launcherId:string,mcpIds:string[]):Promise<void>{
    const launcher=await this.get(launcherId);
    if(!launcher||launcher.type!=='runtime_launcher')throw Object.assign(new Error('Runtime Launcher is unavailable'),{statusCode:400});
    await this.validateBindings(mcpIds);
  }

  async resolveLauncher(record:EnvironmentRecord):Promise<{launcher:Extract<EnvironmentRecord,{type:'runtime_launcher'}>;mcpEnvironmentIds:string[];defaultModelId:string|null}>{
    if(record.type==='runtime_launcher')return {launcher:record,mcpEnvironmentIds:[],defaultModelId:null};
    if(record.type!=='execution_environment')throw Object.assign(new Error('Execution environment is unavailable'),{statusCode:400});
    const launcher=await this.get(record.launcherEnvironmentId);
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
      const dependent = (await this.list()).find(record => ('mcpEnvironmentIds' in record&&record.mcpEnvironmentIds.includes(id))||
        (record.type==='execution_environment'&&record.launcherEnvironmentId===id));
      if (dependent) throw Object.assign(new Error(`Environment is still bound by ${dependent.name}`), { statusCode: 409 });
      await unlink(path.join(this.directory, `${id}.json`));
    });
  }

  headers(record: EnvironmentRecord): Record<string, string> {
    return headersFor(record);
  }

  async preflight(record: EnvironmentRecord): Promise<McpPreflightResult | {
    status: "ready" | "failed";
    elapsedMs: number;
    error: string | null;
    capabilities?:RuntimeLauncherCapabilities;
  }> {
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
    if(record.type==='runtime_launcher')return {status:primary.status,elapsedMs:Date.now()-startedAt,error:primary.error,toolCount:0,tools:[],mcpServers:[],...('capabilities' in primary&&primary.capabilities?{capabilities:primary.capabilities}:{})};
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
    const allTools: Array<{ name: string }> = [];
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
