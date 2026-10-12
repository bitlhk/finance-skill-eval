import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {MigrationValidationRunner} from '../application/migration-technical-validator.js';
import type {TechnicalValidation} from '../domain/migration-model.js';

export const migrationSandboxSchema=z.strictObject({
  // Image selection and network policy belong to the operator, never to uploaded code.
  image:z.string().regex(/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64})$/u),
  network:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u).default('none')
    .refine(value=>!['host','bridge','default'].includes(value),'Use none or a dedicated egress-filtered network'),
  timeoutMs:z.number().int().min(1000).max(600000).default(480000),
  maxConcurrent:z.number().int().min(1).max(4).default(1),
});
export type MigrationSandbox=z.infer<typeof migrationSandboxSchema>;
type ScriptInput=Parameters<MigrationValidationRunner['validateScript']>[0];
type McpInput=Parameters<MigrationValidationRunner['validateMcp']>[0];
export type ContainerJob={kind:'SCRIPT'|'MCP';input:Omit<ScriptInput|McpInput,'archive'|'signal'>&{archive:Record<string,string>}};
const resultSchema=z.object({
  validationId:z.string(),toolId:z.string(),assetId:z.string(),assetDigest:z.string(),
  implementationDigest:z.string(),casesDigest:z.string(),status:z.enum(['PASSED','FAILED']),
  startedAt:z.string(),finishedAt:z.string(),
  stages:z.array(z.object({name:z.string(),passed:z.boolean(),message:z.string()})).max(32),
  error:z.string().nullable(),
});

export function containerArguments(config:MigrationSandbox,name:string){
  return ['run','--rm','--init','--interactive','--pull=never','--log-driver=none','--name',name,
    '--user','1000:1000','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges',
    '--memory','768m','--memory-swap','768m','--cpus','1','--pids-limit','128',
    '--network',config.network,'--tmpfs','/tmp:rw,nosuid,nodev,size=536870912,mode=1777',
    '--env','FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS=1','--env','HOME=/tmp',
    '--env','UV_CACHE_DIR=/tmp/uv-cache','--env','UV_PYTHON_INSTALL_DIR=/tmp/uv-python',
    '--env',`FINANCE_EVAL_CONTAINER_DEADLINE_MS=${config.timeoutMs}`,
    '--entrypoint','node',config.image,'/app/dist/migration/infrastructure/container-validation-entry.js'];
}

/** One disposable container per trial. No volumes, host environment, socket, or published ports. */
export class ContainerMigrationValidationRunner implements MigrationValidationRunner {
  private active=0;
  private closing=false;
  private controllers=new Set<AbortController>();
  private pending=new Set<Promise<unknown>>();
  private readonly config:MigrationSandbox;
  constructor(config:MigrationSandbox){this.config=migrationSandboxSchema.parse(config);}
  validateScript(input:ScriptInput){return this.trial('SCRIPT',input);}
  validateMcp(input:McpInput){
    if(!input.service||input.endpoint)throw Object.assign(new Error('隔离试运行仅启动候选包中的 MCP，不连接外部 MCP 地址。'),{statusCode:400});
    return this.trial('MCP',input);
  }
  async close(){this.closing=true;for(const controller of this.controllers)controller.abort(new Error('Trial executor shutting down'));await Promise.allSettled([...this.pending]);}
  private trial(kind:ContainerJob['kind'],input:ScriptInput|McpInput){
    if(this.closing)throw Object.assign(new Error('隔离试运行环境正在关闭。'),{statusCode:503});
    const controller=new AbortController();this.controllers.add(controller);
    const signal=input.signal?AbortSignal.any([input.signal,controller.signal]):controller.signal;
    const job=this.run(kind,{...input,signal});this.pending.add(job);
    void job.finally(()=>{this.controllers.delete(controller);this.pending.delete(job);}).catch(()=>{});
    return job;
  }
  private async run(kind:ContainerJob['kind'],input:ScriptInput|McpInput):Promise<TechnicalValidation>{
    input.signal?.throwIfAborted();
    if(this.active>=this.config.maxConcurrent)throw Object.assign(new Error('隔离试运行环境繁忙，请稍后重试。'),{statusCode:429});
    const {archive,signal,...values}=input;
    if(!archive)throw Object.assign(new Error('隔离试运行缺少候选包。'),{statusCode:400});
    const payload=JSON.stringify({kind,input:{...values,archive:Object.fromEntries(Object.entries(archive).map(([name,bytes])=>[name,Buffer.from(bytes).toString('base64')]))}} satisfies ContainerJob);
    if(Buffer.byteLength(payload)>16*1024*1024)throw Object.assign(new Error('候选包超过隔离试运行大小限制。'),{statusCode:413});
    this.active++;
    const name='finance-trial-'+randomUUID();
    try{
      const output=await this.execute(name,payload,signal);
      const result=resultSchema.parse(JSON.parse(output));
      if(result.assetId!==input.asset.assetId||result.assetDigest!==input.asset.artifactSha256
        ||result.toolId!==input.tool.toolId)
        throw new Error('Invalid container result');
      return {...result,mode:'ISOLATED_CONTAINER'};
    }catch{
      if(signal?.aborted)throw signal.reason;
      // Docker diagnostics and candidate output can contain injected test credentials.
      throw Object.assign(new Error('隔离试运行未完成，请检查容器执行器、候选实现及网络配置。'),{statusCode:503});
    }finally{await this.remove(name);this.active--;}
  }
  private async remove(name:string){
    // Retry after CLI termination, including cancellation during container creation.
    for(let attempt=0;attempt<3;attempt++){
      await new Promise<void>(resolve=>{
        const cleanup=spawn('docker',['rm','--force',name],{stdio:'ignore',windowsHide:true});
        const timer=setTimeout(()=>{cleanup.kill('SIGKILL');resolve();},5000);
        const done=()=>{clearTimeout(timer);resolve();};
        cleanup.once('error',done);cleanup.once('close',done);
      });
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  private execute(name:string,payload:string,signal?:AbortSignal):Promise<string>{
    return new Promise((resolve,reject)=>{
      const child=spawn('docker',containerArguments(this.config,name),{stdio:['pipe','pipe','pipe'],windowsHide:true});
      child.stdout.setEncoding('utf8');
      let stdout='',settled=false;
      const finish=(error?:Error)=>{
        if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
        if(error)reject(error);else resolve(stdout);
      };
      const stop=(message:string)=>{
        if(settled)return;
        // The caller removes the named container after the CLI has been stopped.
        child.kill('SIGKILL');finish(new Error(message));
      };
      const timer=setTimeout(()=>stop('Container trial timeout'),this.config.timeoutMs);
      const abort=()=>stop('Container trial cancelled');
      signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',chunk=>{stdout+=String(chunk);if(Buffer.byteLength(stdout)>1024*1024)stop('Container output limit');});
      child.stderr.on('data',()=>{});
      child.stdin.on('error',()=>{});
      child.once('error',()=>finish(new Error('Container executor unavailable')));
      child.once('close',code=>finish(code===0?undefined:new Error('Container trial failed')));
      if(signal?.aborted)abort();else child.stdin.end(payload);
    });
  }
}
