import { createHash,randomUUID } from 'node:crypto';
import type { SkillAssetRecord } from './skill-store.js';
import type { TechnicalValidation,ToolInspection } from './migration-model.js';
import { LocalWorker } from './local-worker.js';
import { validateMcpTool } from '../mcp-preflight.js';

const digest=(values:unknown[])=>createHash('sha256').update(JSON.stringify(values)).digest('hex');
function pythonArgs(archive:Record<string,Uint8Array>,entrypoint:string){
  let directory=entrypoint.replaceAll('\\','/').split('/').slice(0,-1).join('/');
  while(true){
    const project=directory?`${directory}/pyproject.toml`:'pyproject.toml';
    if(archive[project]){
      const args=['run','--project',directory||'.'];
      const lock=directory?`${directory}/uv.lock`:'uv.lock';if(archive[lock])args.push('--locked');
      return [...args,'python','-I',entrypoint];
    }
    if(!directory)return ['run','--no-project','--python','3.11','python','-I',entrypoint];
    directory=directory.split('/').slice(0,-1).join('/');
  }
}

export class TechnicalValidationService{
  constructor(private worker=new LocalWorker()){}
  async validateScript(input:{asset:SkillAssetRecord;archive:Record<string,Uint8Array>;tool:ToolInspection;request?:unknown;signal?:AbortSignal}):Promise<TechnicalValidation>{
    const startedAt=new Date().toISOString(),validationId='technical-'+randomUUID(),entry=input.tool.entrypoint;
    const implementationDigest=digest(input.tool.sourcePaths.map(path=>[path,Buffer.from(input.archive[path]??[]).toString('base64')]));
    const casesDigest=digest([input.request??{}]);
    if(!entry?.path||!['PYTHON','NODE'].includes(entry.kind))return this.failed(validationId,input.asset,input.tool.toolId,implementationDigest,casesDigest,'LOCAL_TRUSTED',startedAt,'没有可执行的 Script 入口');
    const program=entry.kind==='PYTHON'?'uv':'node';
    const args=entry.kind==='PYTHON'?pythonArgs(input.archive,entry.path):[entry.path];
    try{
      const result=await this.worker.run({requestId:validationId,program,args,files:Object.entries(input.archive).map(([path,content])=>({path,content})),stdin:JSON.stringify(input.request??{}),timeoutMs:30_000,maxOutputBytes:256*1024,signal:input.signal});
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
