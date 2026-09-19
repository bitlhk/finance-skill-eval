import { spawn } from 'node:child_process';
import { mkdtemp,mkdir,rm,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type LocalWorkerRequest={requestId:string;program:string;args:string[];files:Array<{path:string;content:Uint8Array}>;stdin?:string;timeoutMs?:number;maxOutputBytes?:number;signal?:AbortSignal};
export type LocalWorkerResult={requestId:string;mode:'LOCAL_TRUSTED';startedAt:string;finishedAt:string;exitCode:number|null;timedOut:boolean;cancelled:boolean;stdout:string;stderr:string;outputTruncated:boolean};

const allowedPrograms=new Set(['node','node.exe','python','python.exe','python3','python3.exe','uv','uv.exe','java','java.exe','javac','javac.exe']);
/**
 * Beyond one-shot runs: a delivered service has to be built before it starts, and that means a
 * package manager -- `npm install` for Node, Maven for Java. Same trust model as the rest of this
 * worker (argv only, never a shell string) and the same `LOCAL_TRUSTED` label on the result:
 * enterprise code on an enterprise workstation, not a sandbox.
 */
const allowedServicePrograms=new Set([...allowedPrograms,'npm','npm.cmd','mvn','mvn.cmd']);

/** A workspace that outlives one process, for anything that has to keep running while it is
 * questioned. Same path rules as `run()`; the caller owns `dispose()`. */
export type LocalWorkerWorkspace={
  directory:string;
  dispose():Promise<void>;
};

export function assertServiceProgram(program:string,allowed:Set<string>=allowedServicePrograms):void{
  const executable=path.basename(program).toLowerCase();
  if(!allowed.has(executable))throw new Error(`Worker program is not allowed to start a service: ${executable}`);
}

function safeRelative(value:string){
  const normalized=value.replaceAll('\\','/').replace(/^\.\//u,'');
  if(!normalized||normalized.startsWith('/')||normalized.split('/').includes('..')||/^[A-Za-z]:/u.test(normalized))throw new Error(`Unsafe worker path: ${value}`);
  return normalized;
}

export class LocalWorker{
  constructor(private tempRoot=os.tmpdir(),private programs=allowedPrograms,private servicePrograms=allowedServicePrograms){}
  /** Materialise files into a temp workspace that stays until `dispose()`. */
  async open(files:Array<{path:string;content:Uint8Array}>):Promise<LocalWorkerWorkspace>{
    const directory=await mkdtemp(path.join(this.tempRoot,'finance-migration-workspace-'));
    try{
      for(const file of files){const relative=safeRelative(file.path),target=path.resolve(directory,relative);
        if(target!==directory&&!target.startsWith(directory+path.sep))throw new Error(`Unsafe worker path: ${file.path}`);
        await mkdir(path.dirname(target),{recursive:true});await writeFile(target,file.content,{mode:0o600});}
    }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
    return {directory,dispose:async()=>{await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});}};
  }
  assertServiceProgram(program:string):void{assertServiceProgram(program,this.servicePrograms);}
  async run(request:LocalWorkerRequest):Promise<LocalWorkerResult>{
    if(process.env.FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS!=='1')throw new Error('Local script execution is disabled; enable only in a trusted local workspace');
    const executable=path.basename(request.program).toLowerCase();
    if(!this.programs.has(executable))throw new Error(`Worker program is not allowed: ${executable}`);
    request.signal?.throwIfAborted();
    const directory=await mkdtemp(path.join(this.tempRoot,'finance-migration-worker-'));
    const startedAt=new Date().toISOString(),limit=request.maxOutputBytes??256*1024;
    try{
      for(const file of request.files){const relative=safeRelative(file.path),target=path.resolve(directory,relative);
        if(target!==directory&&!target.startsWith(directory+path.sep))throw new Error(`Unsafe worker path: ${file.path}`);
        await mkdir(path.dirname(target),{recursive:true});await writeFile(target,file.content,{mode:0o600});}
      const args=request.args.map(arg=>arg.replaceAll('\\','/'));
      return await new Promise<LocalWorkerResult>((resolve,reject)=>{
        const env:NodeJS.ProcessEnv={HOME:directory,USERPROFILE:directory,TMPDIR:directory,TEMP:directory,TMP:directory};
        for(const key of ['PATH','SystemRoot','WINDIR','LANG','LC_ALL'])if(process.env[key])env[key]=process.env[key];
        const child=spawn(request.program,args,{cwd:directory,env,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],windowsHide:true});
        const killTree=()=>{if(!child.pid)return;try{if(process.platform==='win32')spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'}).on('error',()=>child.kill());else process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')child.kill('SIGKILL');}};
        let stdout='',stderr='',timedOut=false,cancelled=false,truncated=false,settled=false;
        const append=(current:string,chunk:unknown)=>{const next=current+String(chunk);if(Buffer.byteLength(next)>limit){truncated=true;killTree();return Buffer.from(next).subarray(0,limit).toString();}return next;};
        child.stdout.on('data',chunk=>{stdout=append(stdout,chunk);});child.stderr.on('data',chunk=>{stderr=append(stderr,chunk);});
        const timer=setTimeout(()=>{timedOut=true;killTree();},request.timeoutMs??30_000);
        const abort=()=>{cancelled=true;killTree();};request.signal?.addEventListener('abort',abort,{once:true});
        // A cancel that arrived while the request was still being set up has already fired its
        // event, so waiting for another one means waiting out the whole timeout instead.
        if(request.signal?.aborted)abort();
        child.once('exit',killTree);
        child.stdin.on('error',()=>{});
        child.on('error',error=>{if(settled)return;settled=true;clearTimeout(timer);request.signal?.removeEventListener('abort',abort);reject(error);});
        child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timer);request.signal?.removeEventListener('abort',abort);resolve({requestId:request.requestId,mode:'LOCAL_TRUSTED',startedAt,finishedAt:new Date().toISOString(),exitCode:code,timedOut,cancelled,stdout,stderr,outputTruncated:truncated});});
        child.stdin.end(request.stdin??'');
      });
    }finally{await rm(directory,{recursive:true,force:true});}
  }
}
