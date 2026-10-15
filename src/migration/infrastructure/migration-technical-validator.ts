import { createHash,randomUUID } from 'node:crypto';
import type { SkillAssetRecord } from '../../shared/contracts/skill-asset.js';
import type { TechnicalValidation,ToolInspection } from '../domain/migration-model.js';
import type { MigrationValidationRunner } from '../application/migration-technical-validator.js';
import type { MigrationCommandResolver } from '../application/migration-command-resolver.js';
import { LocalWorker,type LocalWorkerWorkspace } from '../../service/local-worker.js';
import { startService,type Launchable } from '../../service/service-launch.js';
import { validateMcpTool } from '../../mcp-preflight.js';

const digest=(values:unknown[])=>createHash('sha256').update(JSON.stringify(values)).digest('hex');
const PEP723=/^#\s*\/\/\/\s*script\s*$/mu;

/**
 * Launch a Skill package's Python entrypoint in **the package's own environment**, never the
 * platform's. The package declares its dependencies; we only resolve them.
 *
 * `uv run --no-project python -I <file>` looks equivalent to running the file directly, but it
 * is not: uv only reads a PEP 723 block when the script is uv's own argument. Through the
 * `python` subcommand it builds an empty environment, so a migrated script that declares a
 * dependency would silently run without it -- passing or failing on whatever the platform
 * happens to have installed.
 */
export function pythonCommand(archive:Record<string,Uint8Array>,entrypoint:string){
  const configured=process.env.FINANCE_EVAL_PYTHON;
  if(configured)return {program:configured,args:['-I',entrypoint]};
  let directory=entrypoint.replaceAll('\\','/').split('/').slice(0,-1).join('/');
  while(true){
    const project=directory?`${directory}/pyproject.toml`:'pyproject.toml';
    if(archive[project]){
      const args=['run','--project',directory||'.'];
      const lock=directory?`${directory}/uv.lock`:'uv.lock';if(archive[lock])args.push('--locked');
      return {program:'uv',args:[...args,'python','-I',entrypoint]};
    }
    if(!directory)break;
    directory=directory.split('/').slice(0,-1).join('/');
  }
  const source=archive[entrypoint];
  if(source&&PEP723.test(new TextDecoder('utf-8',{fatal:false}).decode(source)))
    return {program:'uv',args:['run','--no-project',entrypoint]};
  return {program:'uv',args:['run','--no-project','python','-I',entrypoint]};
}

export class LocalMigrationCommandResolver implements MigrationCommandResolver {
  resolve(archive:Record<string,Uint8Array>,entrypoint:string,kind:'PYTHON'|'NODE'){
    return kind==='PYTHON'?pythonCommand(archive,entrypoint):{program:'node',args:[entrypoint]};
  }
}

/** Local/private-workspace adapter. Deployments can replace it with an isolated remote runner. */
export class LocalMigrationValidationRunner implements MigrationValidationRunner{
  constructor(private worker=new LocalWorker(),private commands:MigrationCommandResolver=new LocalMigrationCommandResolver()){}
  async validateScript(input:{asset:SkillAssetRecord;archive:Record<string,Uint8Array>;tool:ToolInspection;request?:unknown;context?:Record<string,unknown>;signal?:AbortSignal}):Promise<TechnicalValidation>{
    const startedAt=new Date().toISOString(),validationId='technical-'+randomUUID(),entry=input.tool.entrypoint;
    const implementationDigest=digest(input.tool.sourcePaths.map(path=>[path,Buffer.from(input.archive[path]??[]).toString('base64')]));
    const casesDigest=digest([input.request??{}]);
    if(!entry?.path||!['PYTHON','NODE'].includes(entry.kind))return this.failed(validationId,input.asset,input.tool.toolId,implementationDigest,casesDigest,'LOCAL_TRUSTED',startedAt,'没有可执行的 Script 入口');
    const command=this.commands.resolve(input.archive,entry.path,entry.kind);
    try{
      const result=await this.worker.run({requestId:validationId,program:command.program,args:command.args,separateWorkspace:true,files:Object.entries(input.archive).map(([path,content])=>({path,content})),stdin:JSON.stringify(input.request??{}),context:input.context,timeoutMs:30_000,maxOutputBytes:256*1024,signal:input.signal});
      const stages=[
        {name:'PROCESS',passed:result.exitCode===0&&!result.timedOut&&!result.cancelled,message:result.cancelled?'用户取消':result.timedOut?'执行超时':`退出码 ${result.exitCode}`},
        {name:'OUTPUT_LIMIT',passed:!result.outputTruncated,message:result.outputTruncated?'输出超过限制':'输出大小正常'},
        {name:'STRUCTURED_OUTPUT',passed:false,message:'输出不是单一 JSON'},
      ];
      try{JSON.parse(result.stdout.trim());stages[2]={name:'STRUCTURED_OUTPUT',passed:true,message:'标准输出是有效 JSON'};}catch{}
      const passed=stages.every(s=>s.passed);
      return {validationId,toolId:input.tool.toolId,assetId:input.asset.assetId,assetDigest:input.asset.artifactSha256,implementationDigest,casesDigest,mode:'LOCAL_TRUSTED',status:passed?'PASSED':'FAILED',startedAt,finishedAt:new Date().toISOString(),stages,error:passed?null:(result.stderr.trim()||'Script 技术验证未通过').slice(0,2000)};
    }catch(error){return this.failed(validationId,input.asset,input.tool.toolId,implementationDigest,casesDigest,'LOCAL_TRUSTED',startedAt,error instanceof Error?error.message:String(error));}
  }
  /**
   * An MCP Tool's interface is what the service advertises, so validating it means starting the
   * service and speaking MCP to it.
   *
   * When the Tool was migrated, the deliverable says how to start it (`start`, and `prepare` for
   * the build step) -- and then the platform starts it, exactly as it runs a migrated Script's
   * entrypoint. An endpoint an operator typed in is the fallback for a Tool that was already an
   * MCP server and has no deliverable: connecting to that checks the protocol, but nothing about
   * whether *our* service starts.
   */
  async validateMcp(input:{asset:SkillAssetRecord;tool:ToolInspection;archive?:Record<string,Uint8Array>;service?:Launchable;endpoint?:string;arguments?:Record<string,unknown>;headers?:Record<string,string>;environment?:Record<string,string>;signal?:AbortSignal}):Promise<TechnicalValidation>{
    const startedAt=new Date().toISOString(),validationId='technical-'+randomUUID();
    const casesDigest=digest([input.arguments??{}]);
    // `service` present means "this Tool is ours to start" -- even if the deliverable forgot the
    // command, because then the answer is NO_START_COMMAND, not a fallback to an endpoint nobody
    // was going to check the service against.
    const launched=Boolean(input.service);
    const implementationDigest=digest([input.tool.sourcePaths,input.service??input.endpoint??null]);
    const failed=(mode:TechnicalValidation['mode'],error:string)=>this.failed(validationId,input.asset,input.tool.toolId,implementationDigest,casesDigest,mode,startedAt,error);
    if(!launched&&Object.keys(input.environment??{}).length)return failed('MCP_HTTP','外部 MCP 服务的运行配置需由部署方设置；平台只能为自己启动的服务注入环境变量。');

    let endpoint=input.endpoint??'', mode:TechnicalValidation['mode']='MCP_HTTP', stop:(()=>Promise<void>)|null=null;
    let workspace:LocalWorkerWorkspace|null=null;
    let executionWorkspace:LocalWorkerWorkspace|null=null;
    if(launched){
      if(!input.archive)return failed('LOCAL_TRUSTED','交付物声明了启动命令，但没有候选包可供启动');
      mode='LOCAL_TRUSTED';
      try{
        workspace=await this.worker.open(Object.entries(input.archive).map(([path,content])=>({path,content})));
        const started=await startService({worker:this.worker,workspace,service:input.service!,environment:input.environment,signal:input.signal});
        if(!started.ok){await workspace.dispose();workspace=null;return failed('LOCAL_TRUSTED',started.error);}
        endpoint=started.running.endpoint;stop=started.running.stop;
      }catch(error){
        await workspace?.dispose().catch(()=>undefined);
        return failed('LOCAL_TRUSTED',error instanceof Error?error.message:String(error));
      }
    }
    try{
      let url:URL;try{url=new URL(endpoint);}catch{return failed(mode,mode==='LOCAL_TRUSTED'?'平台起的服务地址无效':'MCP endpoint 无效');}
      if(!['127.0.0.1','localhost','::1'].includes(url.hostname))return failed(mode,'首期只允许验证本机 MCP endpoint');
      // Same per-request workspace contract as normal Runtime execution. Keep task data
      // separate from service code; an empty trial workspace is not business acceptance.
      executionWorkspace=await this.worker.open([]);
      const headers={...Object.fromEntries(Object.entries(input.headers??{}).filter(([name])=>name.toLowerCase()!=='x-workspace-root')),
        'X-Workspace-Root':executionWorkspace.directory};
      const result=await validateMcpTool({endpoint:url.toString(),toolName:input.tool.name,arguments:input.arguments,headers,signal:input.signal});
      const observed=result.tools.find(tool=>tool.name===input.tool.name),observedDigest=digest([input.tool.sourcePaths,input.service??input.endpoint??null,observed??null]);
      const listed=!!observed;
      const stages=[{name:'PROCESS',passed:launched,message:launched?'交付物声明的启动命令已把服务起在 127.0.0.1':`连接操作者提供的 endpoint：${url.host}`},
        {name:'INITIALIZE_AND_LIST',passed:listed,message:listed?`发现 ${result.tools.length} 个 Tool`:result.error??'初始化失败'},
        {name:'INPUT_SCHEMA',passed:!!observed&&typeof observed.inputSchema==='object'&&observed.inputSchema!==null,message:observed?.inputSchema?'tools/list 返回了输入 Schema':'目标 Tool 没有可验证的输入 Schema'},
        {name:'TOOLS_CALL',passed:result.status==='ready'&&result.callResult!==null,message:result.status==='ready'&&result.callResult!==null?'Tool 调用成功':result.error??'Tool 调用未完成'}];
      const passed=result.status==='ready'&&!!observed&&stages[2]!.passed&&result.callResult!==null;
      return {validationId,toolId:input.tool.toolId,assetId:input.asset.assetId,assetDigest:input.asset.artifactSha256,implementationDigest:observedDigest,casesDigest,mode,status:passed?'PASSED':'FAILED',startedAt,finishedAt:new Date().toISOString(),stages,error:passed?null:result.error};
    }finally{
      await stop?.().catch(()=>undefined);
      await executionWorkspace?.dispose().catch(()=>undefined);
      await workspace?.dispose().catch(()=>undefined);
    }
  }
  private failed(validationId:string,asset:SkillAssetRecord,toolId:string,implementationDigest:string,casesDigest:string,mode:TechnicalValidation['mode'],startedAt:string,error:string):TechnicalValidation{
    return {validationId,toolId,assetId:asset.assetId,assetDigest:asset.artifactSha256,implementationDigest,casesDigest,mode,status:'FAILED',startedAt,finishedAt:new Date().toISOString(),stages:[],error};
  }
}
