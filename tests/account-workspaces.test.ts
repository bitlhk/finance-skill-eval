import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {zipSync,strToU8} from 'fflate';
import Fastify,{type FastifyInstance} from 'fastify';
import {createEvaluationService} from '../src/service/server.js';
import {createAccountWorkspaces,readWorkspaceSeed} from '../src/service/account-workspaces.js';
import {requireManagedRun,managedWorkspaceOperation} from '../src/service/managed-workspace-policy.js';
import {runConfigurationSchema} from '../src/service/contracts.js';

const roots:string[]=[],apps:FastifyInstance[]=[];
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const origin='https://eval.example.test';
const headers=(subject:string)=>({authorization:'Bearer synthetic-ingress','x-demo-user':subject,origin});
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function setup(maximum=64){
  const root=await mkdtemp(path.join(tmpdir(),'account-eval-'));roots.push(root);
  const seed=path.join(root,'seed');await mkdir(seed);
  const config={rootDirectory:path.resolve('.'),dataDirectory:path.join(root,'data'),accessToken:'synthetic-ingress',
    publicDemo:false,workspaceOrigin:origin,workspaceSubject:'studio_2',workspaceMode:'account' as const,
    workspaceSeedDirectory:seed,workspaceSeedSha256:hash('[]'),workspaceMaxAccounts:maximum};
  const app=await createEvaluationService(config);apps.push(app);return {root,seed,config,app};
}
const archive=()=>Buffer.from(zipSync({'SKILL.md':strToU8('---\nname: private-marker\nversion: 1.0.0\ndescription: synthetic\n---\nPRIVATE_ACCOUNT_MARKER_951\n')}));

it('authenticates every account without an administrator whitelist and isolates uploads',async()=>{
  const {app}=await setup();
  expect((await app.inject({url:'/api/catalog',headers:{'x-demo-user':'studio_2'}})).statusCode).toBe(401);
  expect((await app.inject({url:'/api/catalog',headers:{authorization:'Bearer synthetic-ingress'}})).statusCode).toBe(403);
  expect((await app.inject({url:'/api/catalog',headers:headers('studio_../bad')})).statusCode).toBe(403);
  expect((await app.inject({url:'/api/health'})).statusCode).toBe(200);
  const uploaded=await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers('studio_alice'),'content-type':'application/zip'},payload:archive()});
  expect(uploaded.statusCode,uploaded.body).toBe(200);
  const id=uploaded.json().assetId;
  const own=await app.inject({url:'/api/catalog',headers:headers('studio_alice')});
  const other=await app.inject({url:'/api/catalog',headers:headers('studio_bob')});
  expect(own.statusCode).toBe(200);expect(other.statusCode).toBe(200);
  expect(own.json().uploadedSkills.map((a:{assetId:string})=>a.assetId)).toContain(id);
  expect(other.json().uploadedSkills).toEqual([]);
  expect(other.body).not.toContain(id);
  expect(other.json().managedWorkspace).toBe(true);
  expect((await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers('studio_bob'),origin:'https://attacker.test','content-type':'application/zip'},payload:archive()})).statusCode).toBe(403);
});

it('keeps the original owner history in place without publishing it to another account',async()=>{
  const {app,config}=await setup();
  const legacy=await createEvaluationService({...config,workspaceMode:'single'});
  const result=await legacy.inject({method:'POST',url:'/api/skills/upload',headers:{...headers('studio_2'),'content-type':'application/zip'},payload:archive()});
  const id=result.json().assetId;await legacy.close();
  const original=path.join(config.dataDirectory,'skills','records',`${id}.json`),before=await readFile(original);
  expect((await app.inject({url:'/api/catalog',headers:headers('studio_2')})).json().uploadedSkills.map((a:{assetId:string})=>a.assetId)).toContain(id);
  expect((await app.inject({url:'/api/catalog',headers:headers('studio_new')})).body).not.toContain(id);
  expect(await readFile(original)).toEqual(before);
});

it('shares reviewed seed files as separate copies and initializes a simultaneous first account once',async()=>{
  const {app,config,seed}=await setup();await app.close();apps.splice(apps.indexOf(app),1);
  const source=await createEvaluationService({...config,workspaceMode:'single',dataDirectory:seed});
  const created=await source.inject({method:'POST',url:'/api/skills/upload',headers:{...headers('studio_2'),'content-type':'application/zip'},payload:archive()});
  await source.close();
  // Only reviewed initial content is a seed; remove empty private-store directories.
  const {readdir}=await import('node:fs/promises');
  for(const name of await readdir(seed))if(!['skills','environments','preparations'].includes(name))await rm(path.join(seed,name),{recursive:true});
  const entries:Array<{path:string;sha256:string}>=[];
  async function walk(relative:string){for(const name of (await readdir(path.join(seed,relative),{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){
    const target=path.posix.join(relative,name.name);if(name.isDirectory())await walk(target);else entries.push({path:target,sha256:hash(await readFile(path.join(seed,target)))});
  }}await walk('');
  const service=await createEvaluationService({...config,workspaceSeedSha256:hash(JSON.stringify(entries))});apps.push(service);
  const results=await Promise.all(Array.from({length:5},()=>service.inject({url:'/api/catalog',headers:headers('studio_same')})));
  expect(results.every(r=>r.statusCode===200)).toBe(true);
  const other=await service.inject({url:'/api/catalog',headers:headers('studio_other')});
  expect(other.json().uploadedSkills[0].assetId).toBe(created.json().assetId);
  expect(path.join(config.dataDirectory,'account-workspaces',hash('studio_same'))).not.toBe(path.join(config.dataDirectory,'account-workspaces',hash('studio_other')));
});

it('blocks arbitrary environment credentials and enforces workspace capacity',async()=>{
  const {app}=await setup(1);
  expect((await app.inject({url:'/api/migrations',headers:headers('studio_a')})).statusCode).toBe(200);
  expect((await app.inject({url:'/api/migrations',headers:headers('studio_b')})).statusCode).toBe(503);
  const reply=await app.inject({method:'POST',url:'/api/environments',headers:headers('studio_a'),payload:{name:'exfiltrate',type:'runtime_launcher',runtimeType:'agentscope',baseUrl:'https://attacker.example/',credentialEnv:'MODEL_SECRET'}});
  expect(reply.statusCode).toBe(403);expect(reply.json().error).toBe('MANAGED_CONFIGURATION_REQUIRED');
  expect(managedWorkspaceOperation('POST','/api/migrations/migration-a/check-business-connection')).toBe(false);
  expect(managedWorkspaceOperation('POST','/api/migrations/migration-a/validate/technical')).toBe(false);
  expect(managedWorkspaceOperation('POST','/api/migrations/migration-a/validate/technical',{migrationSandboxEnabled:true})).toBe(true);
  expect(managedWorkspaceOperation('POST','/api/migrations/migration-a/native-candidate')).toBe(true);
});

it('refuses seed history, wrong digests and symlinks',async()=>{
  const {seed}=await setup();
  await expect(readWorkspaceSeed(seed,'a'.repeat(64))).rejects.toThrow('DIGEST_MISMATCH');
  await mkdir(path.join(seed,'runs'));
  await expect(readWorkspaceSeed(seed,hash('[]'))).rejects.toThrow('CONTENT_NOT_ALLOWED');
  await rm(path.join(seed,'runs'),{recursive:true});
  await symlink(seed,path.join(seed,'skills'));
  await expect(readWorkspaceSeed(seed,hash('[]'))).rejects.toThrow('SYMLINK');
});

it('does not accept arbitrary execution payloads even when they use a managed Launcher',()=>{
  const base=runConfigurationSchema.parse({packId:'example',runtime:{type:'runtime_launcher',environmentId:'env-managed'}});
  expect(()=>requireManagedRun(base)).not.toThrow();
  expect(()=>requireManagedRun({...base,runtimeHarnessTools:['bash']})).toThrow('平台已准入');
  expect(()=>requireManagedRun({...base,runtimeMcpBindings:{left:[],right:[{assetDigest:'a'.repeat(64),toolNames:['x'],filePaths:['run.js'],start:['node','run.js']}]}})).toThrow('平台已准入');
});

it('rejects excess work before the child handler and always permits reads and cancellation',async()=>{
  const {app,config}=await setup();await app.close();apps.splice(apps.indexOf(app),1);
  const calls:string[]=[];
  const service=await createAccountWorkspaces({...config,host:'127.0.0.1',port:0,publicDirectory:'',maxConcurrentRuns:1,
    workspaceRequestLimits:{perAccount:1,global:2,windowSeconds:60},
    workspacePreflightLimits:{perAccount:2,global:4,windowSeconds:60}},async()=>{
    const child=Fastify();
    child.all('/api/*',async request=>{calls.push(request.url);return {handled:true};});
    return child;
  });apps.push(service);
  const send=(subject:string,url:string,method:'GET'|'POST'='POST')=>service.inject({method,url,headers:headers(subject)});
  for(let i=0;i<2;i++)expect((await send('studio_a','/api/environments/env-a/preflight')).statusCode).toBe(200);
  expect((await send('studio_a','/api/environments/env-a/preflight')).statusCode).toBe(429);
  expect(calls).toHaveLength(2);calls.length=0;
  expect((await service.inject({method:'POST',url:'/api/runs',headers:{...headers('studio_a'),authorization:'Bearer wrong'}})).statusCode).toBe(401);
  expect((await send('studio_a','/api/runs')).statusCode).toBe(200);
  const denied=await send('studio_a','/api/migrations/m/analyze');
  expect(denied.statusCode).toBe(429);expect(denied.headers['retry-after']).toBe('60');
  expect(denied.json().scope).toBe('ACCOUNT');
  expect((await send('studio_b','/api/skills/s/prepare')).statusCode).toBe(200);
  expect((await send('studio_c','/api/migrations/m/%64iagnosis?view=all','GET')).statusCode).toBe(429);
  expect(calls).toEqual(['/api/runs','/api/skills/s/prepare']);
  expect((await send('studio_a','/api/runs/run-a','GET')).statusCode).toBe(200);
  expect((await send('studio_a','/api/runs/run-a/cancel')).statusCode).toBe(200);
  expect((await send('studio_b','/api/optimizations/o/decision')).statusCode).toBe(200);
  expect(calls).toHaveLength(5);
});

it('preserves HTTP uploads, SSE and persisted history without exposing another account records',async()=>{
  const {app,config}=await setup();
  const base=await app.listen({host:'127.0.0.1',port:0});
  const uploaded=await fetch(`${base}/api/skills/upload`,{method:'POST',headers:{...headers('studio_alice'),'content-type':'application/zip'},body:archive()});
  expect(uploaded.status).toBe(200);
  const asset=await uploaded.json() as {assetId:string};
  const project=await app.inject({method:'POST',url:'/api/migrations',headers:headers('studio_alice'),payload:{sourceAssetId:asset.assetId,name:'Isolated migration'}});
  expect(project.statusCode,project.body).toBe(200);
  const projectId=project.json().id;
  const created=await app.inject({method:'POST',url:'/api/runs',headers:headers('studio_alice'),payload:{
    packId:'wealth-manager-assistant-professional-value-v1',runtime:{type:'replay'},judgeMode:'deterministic',selectedCaseIds:['WM-SKILL-EVAL-001'],
  }});
  expect(created.statusCode,created.body).toBe(202);
  const id=created.json().jobId;
  const abort=new AbortController();
  try{
    const events=await fetch(`${base}/api/runs/${id}/events`,{headers:headers('studio_alice'),signal:abort.signal});
    expect(events.status).toBe(200);expect(events.headers.get('content-type')).toContain('text/event-stream');
    const first=await events.body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain(id);
  }finally{abort.abort();}
  await expect.poll(async()=>(await app.inject({url:`/api/runs/${id}`,headers:headers('studio_alice')})).json().status,{timeout:15000}).toBe('completed');
  for(const url of [`/api/runs/${id}`,`/api/runs/${id}/export`,`/api/runs/${id}/events`,`/api/migrations/${projectId}`]){
    expect((await app.inject({url,headers:headers('studio_bob')})).statusCode,url).toBe(404);
  }
  expect((await app.inject({method:'POST',url:`/api/runs/${id}/cancel`,headers:headers('studio_bob')})).statusCode).toBe(404);
  await app.close();apps.splice(apps.indexOf(app),1);
  const restarted=await createEvaluationService(config);apps.push(restarted);
  expect((await restarted.inject({url:`/api/runs/${id}`,headers:headers('studio_alice')})).json().status).toBe('completed');
  expect((await restarted.inject({url:`/api/migrations/${projectId}`,headers:headers('studio_alice')})).statusCode).toBe(200);
  expect((await restarted.inject({url:`/api/runs/${id}`,headers:headers('studio_bob')})).statusCode).toBe(404);
  expect((await restarted.inject({url:'/api/catalog',headers:headers('studio_alice')})).json().uploadedSkills.map((item:{assetId:string})=>item.assetId)).toContain(asset.assetId);
});
