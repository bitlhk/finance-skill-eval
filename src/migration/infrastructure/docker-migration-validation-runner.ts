import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type {SkillAssetRecord} from '../../shared/contracts/skill-asset.js';
import {validateMcpTool} from '../../mcp-preflight.js';
import type {MigrationValidationRunner} from '../application/migration-technical-validator.js';
import type {TechnicalValidation,ToolInspection} from '../domain/migration-model.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeName=(value:string)=>value.replace(/[^a-z0-9_.-]+/giu,'-').slice(0,48);
const OUTPUT_LIMIT=256*1024;

type ProcessResult={exitCode:number|null;stdout:string;stderr:string;timedOut:boolean;cancelled:boolean;truncated:boolean};

function relativeFile(value:string){
  const normalized=value.replaceAll('\\','/').replace(/^\.\//u,'');
  if(!normalized||normalized.startsWith('/')||normalized.split('/').includes('..')||/^[A-Za-z]:/u.test(normalized))throw new Error(`Unsafe sandbox path: ${value}`);
  return normalized;
}

async function waitForPort(host:string,port:number,timeoutMs:number,signal?:AbortSignal){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){signal?.throwIfAborted();const open=await new Promise<boolean>(resolve=>{const socket=createConnection({host,port});socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>{socket.destroy();resolve(false)});});if(open)return;await new Promise(resolve=>setTimeout(resolve,250));}
  throw new Error('Sandbox service did not become ready');
}

function run(program:string,args:string[],options:{stdin?:string;timeoutMs?:number;signal?:AbortSignal}={}):Promise<ProcessResult>{
  options.signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(program,args,{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH},windowsHide:true});
    let stdout='',stderr='',timedOut=false,cancelled=false,truncated=false,settled=false;
    const append=(current:string,chunk:unknown)=>{const next=current+String(chunk);if(Buffer.byteLength(next)>OUTPUT_LIMIT){truncated=true;child.kill('SIGKILL');return Buffer.from(next).subarray(0,OUTPUT_LIMIT).toString()}return next};
    child.stdout.on('data',chunk=>{stdout=append(stdout,chunk)});child.stderr.on('data',chunk=>{stderr=append(stderr,chunk)});
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},options.timeoutMs??30_000);
    const abort=()=>{cancelled=true;child.kill('SIGKILL')};options.signal?.addEventListener('abort',abort,{once:true});
    child.on('error',error=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);reject(error)});
    child.on('close',exitCode=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);resolve({exitCode,stdout,stderr,timedOut,cancelled,truncated})});
    child.stdin.end(options.stdin??'');
  });
}

async function materialize(archive:Record<string,Uint8Array>){
  const directory=await mkdtemp(path.join(os.tmpdir(),'finance-eval-sandbox-'));
  try{for(const [name,bytes] of Object.entries(archive)){const relative=relativeFile(name),target=path.resolve(directory,relative);if(!target.startsWith(directory+path.sep))throw new Error(`Unsafe sandbox path: ${name}`);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes,{mode:0o600});}return directory;}
  catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}

function containerBase(image:string,name:string,workspace:string,network:string){
  return ['run','--rm','--interactive','--name',name,'--network',network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--pids-limit','64','--memory','384m','--cpus','1','--tmpfs','/tmp:rw,nosuid,nodev,size=64m','--user',`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,
    '--mount',`type=bind,src=${workspace},dst=/workspace,readonly`,'--workdir','/workspace',image];
}

function scriptCommand(tool:ToolInspection,archive:Record<string,Uint8Array>){
  const entry=relativeFile(tool.entrypoint?.path??'');if(!archive[entry])throw new Error('Sandbox entrypoint is not present in the candidate archive');
  if(tool.entrypoint?.kind==='PYTHON')return ['python3','-I',`/workspace/${entry}`];
  if(tool.entrypoint?.kind==='NODE')return ['node',`/workspace/${entry}`];
  throw new Error('Sandbox supports Python and Node scripts only');
}

function serviceCommand(start:string[]|undefined,archive:Record<string,Uint8Array>){
  if(!start?.length)throw new Error('Generated MCP service does not declare a start command');
  const program=path.basename(start[0]!).toLowerCase();
  if(!['python','python3','node','uv'].includes(program))throw new Error(`Sandbox does not admit MCP program: ${program}`);
  const candidate=start.slice(1).map(value=>value.replaceAll('\\','/')).find(value=>archive[value]&&/\.(?:py|js|mjs|cjs)$/iu.test(value));
  if(!candidate)throw new Error('MCP start command does not reference a packaged entrypoint');
  const entry=relativeFile(candidate);
  return entry.endsWith('.py')?['python3',`/workspace/${entry}`]:['node',`/workspace/${entry}`];
}

/** Executes uploaded code only inside an operator-pinned, network-isolated OCI image. */
export class DockerMigrationValidationRunner implements MigrationValidationRunner{
  constructor(private readonly image:string,private readonly docker='docker'){
    if(!/^[a-z0-9][a-z0-9./:@_-]{0,255}$/iu.test(image))throw new Error('Invalid migration sandbox image');
  }
  private result(asset:SkillAssetRecord,tool:ToolInspection,validationId:string,implementationDigest:string,casesDigest:string,startedAt:string,stages:TechnicalValidation['stages'],error:string|null):TechnicalValidation{
    return {validationId,toolId:tool.toolId,assetId:asset.assetId,assetDigest:asset.artifactSha256,implementationDigest,casesDigest,mode:'SANDBOXED',status:error?'FAILED':'PASSED',startedAt,finishedAt:new Date().toISOString(),stages,error};
  }
  async validateScript(input:{asset:SkillAssetRecord;archive:Record<string,Uint8Array>;tool:ToolInspection;request?:unknown;context?:Record<string,unknown>;signal?:AbortSignal}){
    const validationId=`technical-${randomUUID()}`,startedAt=new Date().toISOString(),implementationDigest=digest(input.tool.sourcePaths.map(name=>[name,Buffer.from(input.archive[name]??[]).toString('base64')])),casesDigest=digest(input.request??{});
    if(Object.keys(input.context??{}).length)return this.result(input.asset,input.tool,validationId,implementationDigest,casesDigest,startedAt,[],'隔离 Script 不接收宿主上下文；请迁移为 MCP 并使用受管连接。');
    let workspace:string|null=null;
    try{
      workspace=await materialize(input.archive);const command=scriptCommand(input.tool,input.archive),name=`finance-eval-${safeName(validationId)}`;
      const executed=await run(this.docker,[...containerBase(this.image,name,workspace,'none'),...command],{stdin:JSON.stringify(input.request??{}),timeoutMs:30_000,signal:input.signal});
      const stages=[{name:'SANDBOX',passed:true,message:`临时容器 ${this.image} 无网络、无额外权限并受资源限制`},
        {name:'PROCESS',passed:executed.exitCode===0&&!executed.timedOut&&!executed.cancelled,message:executed.cancelled?'用户取消':executed.timedOut?'执行超时':`退出码 ${executed.exitCode}`},
        {name:'OUTPUT_LIMIT',passed:!executed.truncated,message:executed.truncated?'输出超过限制':'输出大小正常'},
        {name:'STRUCTURED_OUTPUT',passed:false,message:'输出不是单一 JSON'},{name:'SANDBOX_DISPOSED',passed:true,message:'一次性容器已退出并删除'}];
      try{JSON.parse(executed.stdout.trim());stages[3]={name:'STRUCTURED_OUTPUT',passed:true,message:'标准输出是有效 JSON'}}catch{}
      const passed=stages.every(stage=>stage.passed);return this.result(input.asset,input.tool,validationId,implementationDigest,casesDigest,startedAt,stages,passed?null:(executed.stderr.trim()||'隔离 Script 试运行未通过').slice(0,2000));
    }catch(error){return this.result(input.asset,input.tool,validationId,implementationDigest,casesDigest,startedAt,[],error instanceof Error?error.message:String(error));}
    finally{if(workspace)await rm(workspace,{recursive:true,force:true});}
  }
  async validateMcp(input:{asset:SkillAssetRecord;tool:ToolInspection;archive?:Record<string,Uint8Array>;service?:{start?:string[];prepare?:string[]};endpoint?:string;arguments?:Record<string,unknown>;headers?:Record<string,string>;environment?:Record<string,string>;signal?:AbortSignal}){
    const validationId=`technical-${randomUUID()}`,startedAt=new Date().toISOString(),implementationDigest=digest([input.tool.sourcePaths,input.service??null]),casesDigest=digest(input.arguments??{});
    if(!input.service||!input.archive)return this.result(input.asset,input.tool,validationId,implementationDigest,casesDigest,startedAt,[],'受管工作区只试运行当前候选包内的 MCP 服务，不连接用户填写的任意地址。');
    if(input.service.prepare?.length)return this.result(input.asset,input.tool,validationId,implementationDigest,casesDigest,startedAt,[],'候选声明了在线安装依赖；隔离试运行不开放软件源，请将依赖锁定到平台准入的沙箱镜像。');
    if(Object.keys(input.environment??{}).length)return this.result(input.asset,input.tool,validationId,implementationDigest,casesDigest,startedAt,[],'候选需要外部服务配置；请先绑定受管测试连接，隔离容器不会获得任意外网访问。');
    let workspace:string|null=null,container:string|null=null,network:string|null=null;
    let validation:TechnicalValidation;
    try{
      workspace=await materialize(input.archive);const command=serviceCommand(input.service.start,input.archive),suffix=randomUUID().replaceAll('-','').slice(0,12);container=`finance-eval-mcp-${suffix}`;network=`finance-eval-isolated-${suffix}`;
      const created=await run(this.docker,['network','create','--internal',network],{timeoutMs:15_000,signal:input.signal});if(created.exitCode!==0)throw new Error('Cannot create isolated sandbox network');
      const args=['run','--detach','--rm','--name',container,'--network',network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','384m','--cpus','1','--tmpfs','/tmp:rw,nosuid,nodev,size=64m','--user',`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,'--mount',`type=bind,src=${workspace},dst=/workspace,readonly`,'--workdir','/workspace','--env','PORT=8080',this.image,...command];
      const started=await run(this.docker,args,{timeoutMs:30_000,signal:input.signal});if(started.exitCode!==0)throw new Error((started.stderr||'Sandbox MCP service failed to start').slice(0,800));
      const inspected=await run(this.docker,['inspect','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',container],{timeoutMs:15_000,signal:input.signal});
      const sandboxHost=inspected.stdout.trim();if(inspected.exitCode!==0||!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(sandboxHost))throw new Error('Cannot resolve isolated sandbox address');
      await waitForPort(sandboxHost,8080,30_000,input.signal);
      const checked=await validateMcpTool({endpoint:`http://${sandboxHost}:8080/mcp`,toolName:input.tool.name,arguments:input.arguments,headers:input.headers,signal:input.signal});
      const observed=checked.tools.find(tool=>tool.name===input.tool.name),stages:TechnicalValidation['stages']=[{name:'SANDBOX',passed:true,message:`临时容器 ${this.image} 使用独立内部网络，不能访问宿主和外网`},
        {name:'INITIALIZE_AND_LIST',passed:Boolean(observed),message:observed?`发现 ${checked.tools.length} 个 Tool`:checked.error??'初始化失败'},
        {name:'INPUT_SCHEMA',passed:Boolean(observed?.inputSchema&&typeof observed.inputSchema==='object'),message:observed?.inputSchema?'tools/list 返回了输入 Schema':'目标 Tool 没有可验证的输入 Schema'},
        {name:'TOOLS_CALL',passed:checked.status==='ready'&&checked.callResult!==null,message:checked.status==='ready'&&checked.callResult!==null?'Tool 调用成功':checked.error??'Tool 调用未完成'}];
      const passed=stages.every(stage=>stage.passed);validation=this.result(input.asset,input.tool,validationId,digest([implementationDigest,observed??null]),casesDigest,startedAt,stages,passed?null:checked.error??'隔离 MCP 试运行未通过');
    }catch(error){
      const logs=container?await run(this.docker,['logs','--tail','80',container],{timeoutMs:15_000}).catch(()=>null):null;
      const detail=[error instanceof Error?error.message:String(error),logs?.stderr.trim(),logs?.stdout.trim()].filter(Boolean).join('\n').slice(0,4000);
      validation=this.result(input.asset,input.tool,validationId,implementationDigest,casesDigest,startedAt,[],detail);
    }
    finally{
      if(container)await run(this.docker,['rm','--force',container],{timeoutMs:15_000}).catch(()=>undefined);
      if(network)await run(this.docker,['network','rm',network],{timeoutMs:15_000}).catch(()=>undefined);
      const containerGone=!container||(await run(this.docker,['container','inspect',container],{timeoutMs:15_000}).catch(()=>null))?.exitCode!==0;
      const networkGone=!network||(await run(this.docker,['network','inspect',network],{timeoutMs:15_000}).catch(()=>null))?.exitCode!==0;
      let workspaceGone=true;
      if(workspace)try{await rm(workspace,{recursive:true,force:true});}catch{workspaceGone=false;}
      const disposed=containerGone&&networkGone&&workspaceGone;
      validation!.stages.push({name:'SANDBOX_DISPOSED',passed:disposed,message:disposed?'容器、隔离网络和临时文件已删除':'隔离资源未能完整确认删除'});
      validation!.finishedAt=new Date().toISOString();
      if(!disposed){validation!.status='FAILED';validation!.error=validation!.error??'隔离资源未能完整确认删除';}
    }
    return validation!;
  }
}
