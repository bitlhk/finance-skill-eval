import {createHash,timingSafeEqual} from 'node:crypto';
import {lstat,mkdir,readdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import Fastify,{type FastifyInstance} from 'fastify';
import type {ServiceConfig} from './config.js';
import {WorkspaceRequestBudget,requiresWorkspaceBudget} from './workspace-request-budget.js';

const subjectPattern=/^studio_[a-zA-Z0-9_-]{1,120}$/u;
const seedRoots=new Set(['skills','environments','preparations']);
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const fail=(message:string):never=>{throw new Error(message);};

/** Operator-reviewed initial content only; never copy another user's workspace. */
export async function readWorkspaceSeed(directory:string,expectedDigest:string){
  if(!/^[a-f0-9]{64}$/u.test(expectedDigest))fail('WORKSPACE_SEED_DIGEST_REQUIRED');
  const files:Array<{name:string;bytes:Buffer}>=[];
  let total=0;
  async function walk(relative:string){
    const target=path.join(directory,relative),stat=await lstat(target);
    if(stat.isSymbolicLink())fail('WORKSPACE_SEED_SYMLINK');
    if(stat.isDirectory()){
      for(const name of (await readdir(target)).sort()){
        if(!relative&&!seedRoots.has(name))fail('WORKSPACE_SEED_CONTENT_NOT_ALLOWED');
        await walk(path.posix.join(relative,name));
      }
    }else{
      if(!stat.isFile()||stat.size>8*1024*1024)fail('WORKSPACE_SEED_FILE_INVALID');
      total+=stat.size;
      if(total>32*1024*1024||files.length>=2000)fail('WORKSPACE_SEED_TOO_LARGE');
      const bytes=await readFile(target);
      if(bytes.length!==stat.size)fail('WORKSPACE_SEED_CHANGED');
      files.push({name:relative,bytes});
    }
  }
  await walk('');
  const actual=hash(JSON.stringify(files.map(file=>({path:file.name,sha256:hash(file.bytes)}))));
  if(actual!==expectedDigest)fail('WORKSPACE_SEED_DIGEST_MISMATCH');
  return files;
}

/** Receives identity only from an authenticated, header-replacing SSO ingress. */
export async function createAccountWorkspaces(config:ServiceConfig,
  factory:(config:Partial<ServiceConfig>)=>Promise<FastifyInstance>){
  if(!config.accessToken||config.publicDemo||!config.workspaceOrigin?.startsWith('https://')
    ||new URL(config.workspaceOrigin).origin!==config.workspaceOrigin
    ||(config.workspaceSubject&&!subjectPattern.test(config.workspaceSubject)))
    fail('Account workspaces require a trusted ingress credential and HTTPS origin');
  const maximum=config.workspaceMaxAccounts??64;
  if(!Number.isInteger(maximum)||maximum<1||maximum>256)fail('WORKSPACE_ACCOUNT_LIMIT_INVALID');
  const requestBudget=new WorkspaceRequestBudget(config.workspaceRequestLimits??{
    perAccount:20,global:80,windowSeconds:60,
  });
  if(!config.workspaceSeedDirectory||!config.workspaceSeedSha256)throw new Error('WORKSPACE_SEED_REQUIRED');
  const seed=await readWorkspaceSeed(config.workspaceSeedDirectory,config.workspaceSeedSha256);
  const root=path.join(config.dataDirectory,'account-workspaces');
  await mkdir(root,{recursive:true,mode:0o700});
  if((await lstat(root)).isSymbolicLink())fail('WORKSPACE_DIRECTORY_UNSAFE');
  const apps=new Map<string,Promise<FastifyInstance>>();
  const app=Fastify({logger:true,bodyLimit:8*1024*1024});
  let closing=false;

  async function open(subject:string){
    // The old owner's directory stays in place; this is ownership, not a role.
    const directory=subject===config.workspaceSubject?config.dataDirectory:path.join(root,hash(subject));
    if(directory!==config.dataDirectory){
      try{
        const stat=await lstat(directory);
        if(!stat.isDirectory()||stat.isSymbolicLink())fail('WORKSPACE_DIRECTORY_UNSAFE');
      }catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        const staging=path.join(root,`.initializing-${hash(subject)}`);
        await mkdir(staging,{mode:0o700});
        try{
          for(const file of seed){
            const target=path.join(staging,file.name);
            await mkdir(path.dirname(target),{recursive:true,mode:0o700});
            await writeFile(target,file.bytes,{flag:'wx',mode:0o600});
          }
          await writeFile(path.join(staging,'workspace-origin.json'),JSON.stringify({
            schemaVersion:'finance.account-workspace.v1',subjectHash:hash(subject),seedSha256:config.workspaceSeedSha256,
          }),{flag:'wx',mode:0o600});
          await rename(staging,directory);
        }catch(error){await rm(staging,{recursive:true,force:true});throw error;}
      }
    }
    const child=await factory({workspaceMode:'single',workspaceSubject:subject,dataDirectory:directory,managedWorkspace:true});
    await child.ready();
    return child;
  }
  app.addHook('onRequest',async(request,reply)=>{
    if(!request.url.startsWith('/api/'))return;
    reply.header('cache-control','no-store');
    if(request.url==='/api/health')return;
    const actual=Buffer.from(typeof request.headers.authorization==='string'?request.headers.authorization:'');
    const expected=Buffer.from(`Bearer ${config.accessToken}`);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))
      return reply.code(401).send({error:'UNAUTHORIZED'});
    const subject=request.headers['x-demo-user'];
    if(typeof subject!=='string'||!subjectPattern.test(subject))return reply.code(403).send({error:'AUTHENTICATED_ACCOUNT_REQUIRED'});
    if(!['GET','HEAD','OPTIONS'].includes(request.method)&&request.headers.origin!==config.workspaceOrigin)
      return reply.code(403).send({error:'WORKSPACE_ORIGIN_REQUIRED'});
    if(closing)return reply.code(503).send({error:'WORKSPACES_CLOSING'});
    if(requiresWorkspaceBudget(request.method,request.url)){
      const refusal=requestBudget.take(subject);
      if(refusal)return reply.code(429).header('retry-after',String(refusal.retryAfterSeconds)).send({
        error:'WORKSPACE_REQUEST_LIMIT',scope:refusal.scope,retryAfterSeconds:refusal.retryAfterSeconds,
        message:`${refusal.scope==='ACCOUNT'?'当前账号':'当前服务'}请求较多，请在 ${refusal.retryAfterSeconds} 秒后重试。已有任务继续运行，仍可查看或取消。`,
      });
    }
    if(!apps.has(subject)){
      if(apps.size>=maximum)return reply.code(503).send({error:'WORKSPACE_CAPACITY_REACHED'});
      const opening=open(subject);
      apps.set(subject,opening);
      opening.catch(()=>{if(apps.get(subject)===opening)apps.delete(subject);});
    }
    let child:FastifyInstance;
    try{child=await apps.get(subject)!;}catch{return reply.code(503).send({error:'WORKSPACE_INITIALIZATION_FAILED'});}
    // Forward the untouched stream so uploads and SSE retain existing semantics.
    reply.hijack();
    child.routing(request.raw,reply.raw);
  });
  app.get('/api/health',async()=>({status:'ready',deploymentMode:'account-workspaces'}));
  app.all('/api/*',async(_request,reply)=>reply.code(404).send({error:'NOT_FOUND'}));
  app.addHook('onClose',async()=>{
    closing=true;
    await Promise.all([...apps.values()].map(async value=>{const child=await value.catch(()=>null);await child?.close();}));
  });
  return app;
}
