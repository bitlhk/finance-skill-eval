import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {runtimeProjectRoot,pythonInterpreter} from '../../shared/python-environment.js';

/** Reuses the project's container executor, never runs uploaded Python on the host. */
export async function runVerificationScript(script:string,resources:unknown,signal?:AbortSignal,timeoutMs=60000):Promise<unknown>{
  signal?.throwIfAborted();
  const root=runtimeProjectRoot();
  const containerName='finance-project-'+randomUUID();
  const python=pythonInterpreter(root);
  const workspace=await mkdtemp(path.join(tmpdir(),'finance-verifier-'));
  const child=spawn(python,[path.join(root,'integrations/openjiuwen/project_execution.py')],{cwd:root,windowsHide:true,
    env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'},stdio:['pipe','pipe','pipe']});
  let output='',error='',failure:Error|undefined;
  const cancel=()=>{failure=new Error('Verification cancelled');child.kill();};
  signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>{failure=new Error('Verification timed out');child.kill();},timeoutMs+15000);
  try{
    const completion=new Promise<void>((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',code=>failure?reject(failure):code!==0?reject(new Error('Verification executor failed: '+error.slice(-1000))):resolve());
      child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>64000){failure=new Error('Verification output limit');child.kill();}});
      child.stderr.on('data',chunk=>{error=(error+chunk.toString()).slice(-2000);});
      child.stdin.on('error',()=>{});
    });
    child.stdin.end(JSON.stringify({script,resources,workspace,containerName,timeoutSeconds:Math.ceil(timeoutMs/1000)}));
    await completion;signal?.throwIfAborted();
    const receipt=JSON.parse(output);
    if(receipt.status!=='COMPLETED')throw new Error(`Verifier execution ${receipt.status}: ${String(receipt.output).slice(0,1000)}`);
    return JSON.parse(receipt.output);
  }catch(error){
    failure??=error instanceof Error?error:new Error('Verification failed');
    throw error;
  }finally{
    clearTimeout(timer);signal?.removeEventListener('abort',cancel);
    // Parent cleanup also covers forced worker termination on Windows.
    if(failure)await new Promise<void>(resolve=>{
      const cleanup=spawn('docker',['rm','-f',containerName],{windowsHide:true,stdio:'ignore'});
      const deadline=setTimeout(()=>{cleanup.kill();resolve();},10000);
      const done=()=>{clearTimeout(deadline);resolve();};cleanup.once('error',done);cleanup.once('close',done);
    });
    // This directory is created above by this invocation, never supplied by a task.
    await rm(workspace,{recursive:true,force:true});
  }
}
