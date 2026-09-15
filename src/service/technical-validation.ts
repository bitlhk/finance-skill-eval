import { createHash,randomUUID } from 'node:crypto';
import type { SkillAssetRecord } from './skill-store.js';
import type { TechnicalValidation,ToolInspection } from './migration-model.js';
import { LocalWorker } from './local-worker.js';
import { validateMcpTool } from '../mcp-preflight.js';

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

export class TechnicalValidationService{
  constructor(private worker=new LocalWorker()){}
  async validateScript(input:{asset:SkillAssetRecord;archive:Record<string,Uint8Array>;tool:ToolInspection;request?:unknown;signal?:AbortSignal}):Promise<TechnicalValidation>{
    const startedAt=new Date().toISOString(),validationId='technical-'+randomUUID(),entry=input.tool.entrypoint;
    const implementationDigest=digest(input.tool.sourcePaths.map(path=>[path,Buffer.from(input.archive[path]??[]).toString('base64')]));
    const casesDigest=digest([input.request??{}]);
    if(!entry?.path||!['PYTHON','NODE'].includes(entry.kind))return this.failed(validationId,input.asset,input.tool.toolId,implementationDigest,casesDigest,'LOCAL_TRUSTED',startedAt,'没有可执行的 Script 入口');
    const command=entry.kind==='PYTHON'?pythonCommand(input.archive,entry.path):{program:'node',args:[entry.path]};
    try{
      const result=await this.worker.run({requestId:validationId,program:command.program,args:command.args,files:Object.entries(input.archive).map(([path,content])=>({path,content})),stdin:JSON.stringify(input.request??{}),timeoutMs:30_000,maxOutputBytes:256*1024,signal:input.signal});
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
  async validateMcp(input:{asset:SkillAssetRecord;tool:ToolInspection;endpoint:string;arguments?:Record<string,unknown>;signal?:AbortSignal}):Promise<TechnicalValidation>{
    const startedAt=new Date().toISOString(),validationId='technical-'+randomUUID(),implementationDigest=digest([input.tool.sourcePaths,input.endpoint]);
    const casesDigest=digest([input.arguments??{}]);
    let url:URL;try{url=new URL(input.endpoint);}catch{return this.failed(validationId,input.asset,input.tool.toolId,implementationDigest,casesDigest,'MCP_HTTP',startedAt,'MCP endpoint 无效');}
    if(!['127.0.0.1','localhost','::1'].includes(url.hostname))return this.failed(validationId,input.asset,input.tool.toolId,implementationDigest,casesDigest,'MCP_HTTP',startedAt,'首期只允许验证本机 MCP endpoint');
    const result=await validateMcpTool({endpoint:url.toString(),toolName:input.tool.name,arguments:input.arguments,signal:input.signal});
    const observed=result.tools.find(tool=>tool.name===input.tool.name),observedDigest=digest([input.tool.sourcePaths,input.endpoint,observed??null]);
    const stages=[{name:'INITIALIZE_AND_LIST',passed:result.status==='ready',message:result.status==='ready'?`发现 ${result.tools.length} 个 Tool`:result.error??'初始化失败'},
      {name:'INPUT_SCHEMA',passed:!!observed&&typeof observed.inputSchema==='object'&&observed.inputSchema!==null,message:observed?.inputSchema?'tools/list 返回了输入 Schema':'目标 Tool 没有可验证的输入 Schema'},
      {name:'TOOLS_CALL',passed:result.status==='ready'&&result.callResult!==null,message:result.callResult!==null?'Tool 调用成功':'Tool 调用未完成'}];
    const passed=stages.every(s=>s.passed);
    return {validationId,toolId:input.tool.toolId,assetId:input.asset.assetId,assetDigest:input.asset.artifactSha256,implementationDigest:observedDigest,casesDigest,mode:'MCP_HTTP',status:passed?'PASSED':'FAILED',startedAt,finishedAt:new Date().toISOString(),stages,error:passed?null:result.error};
  }
  private failed(validationId:string,asset:SkillAssetRecord,toolId:string,implementationDigest:string,casesDigest:string,mode:TechnicalValidation['mode'],startedAt:string,error:string):TechnicalValidation{
    return {validationId,toolId,assetId:asset.assetId,assetDigest:asset.artifactSha256,implementationDigest,casesDigest,mode,status:'FAILED',startedAt,finishedAt:new Date().toISOString(),stages:[],error};
  }
}
