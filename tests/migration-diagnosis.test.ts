import {it,expect} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {zipSync,strToU8} from 'fflate';
import {createEvaluationService} from '../src/service/server.js';
import {analyzeDependencies,dependencyId} from '../src/migration/infrastructure/migration-dependencies.js';
import {runtimeInjection,migrationExecutionConfig} from '../src/migration/domain/migration-runtime-rules.js';
import {probeBusinessInterface} from '../src/migration/infrastructure/migration-business-connection-probe.js';
import {supplementFiles} from '../src/migration/infrastructure/migration-supplements.js';
import {buildMigrationPlan} from '../src/migration/domain/migration-model.js';
import {SKILL_MD,analyzedTool,inspectionFixture,toolFixture,implementationFixture} from './analysis-fixture.js';
import type {MigrationAnalyzer} from '../src/migration/application/migration-agent-port.js';
import {LocalMigrationValidationRunner} from '../src/migration/infrastructure/migration-technical-validator.js';
import {MigrationStore} from '../src/migration/migration-store.js';

const SOURCE='const user = runtime.user;\n/** @type {string} */ const token = auth_sdk.getToken(user);\nreturn business_client.query(account_id, {Authorization: token});\n';
export function diagnosisPayload(includeCode=false,codePath?:string){
 const ref={toolName:'lookup',path:'tool/lookup.mjs',snippet:'business_client.query(account_id, {Authorization: token})'};
 const runtime={key:'runtime:balance-token',name:'余额接口凭证',kind:'DATA',owner:'RUNTIME',action:'INJECT',contractStatus:'KNOWN',sensitive:true,binding:{kind:'HTTP_HEADER',name:'Authorization'},purpose:'由 Runtime 提供余额接口使用的凭证',blocking:true,availability:'MISSING',references:[ref],resolvedPaths:[],schema:{type:'string'},schemaCompleteness:'COMPLETE',schemaEvidence:[{path:'tool/lookup.mjs',snippet:'/** @type {string} */ const token = auth_sdk.getToken(user);'}]};
 const identity={...runtime,key:'identity:auth',name:'原身份获取逻辑',kind:'SDK',action:'MOVE_TO_RUNTIME',binding:null,schema:null,schemaEvidence:[],schemaCompleteness:'UNKNOWN',references:[{...ref,snippet:'const token = auth_sdk.getToken(user);'}]};
 const code={...runtime,key:'import:business_client',name:'业务接口客户端',kind:'SDK',owner:'TOOL',action:'KEEP',sensitive:false,binding:null,schema:null,schemaEvidence:[],schemaCompleteness:'UNKNOWN',availability:codePath?'AVAILABLE':'MISSING',resolvedPaths:codePath?[codePath]:[],resolutionEvidence:codePath?[{path:codePath,snippet:'export const query = () => ({balance: 100});'}]:[]};
 return {status:'PRODUCED',skill:{status:'COMPLIANT',findings:[]},tools:[analyzedTool({name:'lookup',sourcePaths:['tool/lookup.mjs'],sample:{account_id:'A1'},inputSchema:{type:'object',properties:{account_id:{type:'string'}},required:['account_id']}})],dependencyAnalysis:{dependencies:[runtime,identity,...(includeCode?[code]:[])],chains:[{toolName:'lookup',nodes:[{id:'identity',title:'原 Runtime 提供身份并获取凭证',detail:'迁移后由 Runtime 提供最终凭证',dependencyKeys:['identity:auth'],evidence:[{path:'tool/lookup.mjs',snippet:'const token = auth_sdk.getToken(user);'}]},{id:'business',title:'余额业务接口请求',detail:'工具使用注入凭证查询账户',dependencyKeys:['runtime:balance-token',...(includeCode?['import:business_client']:[])],evidence:[ref]}],edges:[{from:'identity',to:'business'}]}]}};
}

it('maps migration dependencies to MCP headers and rejects Script injection',()=>{
 const inspection=inspectionFixture([toolFixture({name:'lookup',sourcePaths:['tool/lookup.mjs']})]);
 const deps=analyzeDependencies(diagnosisPayload(),inspection,{'tool/lookup.mjs':SOURCE},[],0,'digest').dependencies;
 const dep=deps.find(d=>d.action==='INJECT')!,toolId=inspection.tools[0]!.toolId;
 const config=migrationExecutionConfig(deps,{[dep.id]:'Bearer test'},[{toolId,name:'lookup',kind:'MCP'}]);
 expect(config.tools.lookup!.contextBindings.Authorization).toBe(`context.${dep.id}`);
 expect(config.context[dep.id]!.value).toBe('Bearer test');
 expect(()=>migrationExecutionConfig(deps,{[dep.id]:'Bearer test'},[{toolId,name:'lookup',kind:'SCRIPT'}])).toThrow('Script 不支持');
 expect(migrationExecutionConfig([],{},[{toolId,name:'lookup',kind:'SCRIPT'}]).tools).toEqual({});
});

it('separates runtime contracts from missing values and blocks only unresolved Tool dependencies',()=>{
 const inspection=inspectionFixture([toolFixture({name:'lookup',sourcePaths:['tool/lookup.mjs']})]);
 const files={'tool/lookup.mjs':SOURCE};
 const complete=analyzeDependencies(diagnosisPayload(),inspection,files,[],0,'digest');expect(complete.status).toBe('COMPLETE');expect(complete.dependencies[0]!.availability).toBe('MISSING');
 const mcp=[{toolId:inspection.tools[0]!.toolId,form:'MCP' as const,language:'node',baseAssetId:'asset',reason:'',decidedAt:'now'}];
 expect(buildMigrationPlan({...inspection,dependencyAnalysis:complete},mcp,'asset').generationAllowed).toBe(true);
 expect(()=>migrationExecutionConfig(complete.dependencies,{},[{toolId:inspection.tools[0]!.toolId,name:'lookup',kind:'MCP'}])).toThrow('测试运行依赖未就绪');
 const decisions=[{toolId:inspection.tools[0]!.toolId,form:'SCRIPT' as const,baseAssetId:'asset',reason:'',decidedAt:'now'}];
 const plan=buildMigrationPlan({...inspection,dependencyAnalysis:complete},decisions,'asset');expect(plan.generationAllowed).toBe(false);expect(plan.items[0]!.blockingReasons.join()).toContain('Script 不支持');
 expect(analyzeDependencies(diagnosisPayload(true),inspection,files,[],0,'digest').status).toBe('PARTIAL');
 const fake=diagnosisPayload();fake.dependencyAnalysis.dependencies[0]!.references[0]!.snippet='nonexistent evidence';expect(analyzeDependencies(fake,inspection,files,[],0,'digest').status).toBe('PARTIAL');
});

it('keeps Runtime injection out of business inputs, rejects header spoofing and conflicts',()=>{
 const inspection=inspectionFixture([toolFixture({name:'lookup',sourcePaths:['tool/lookup.mjs']})]);const deps=analyzeDependencies(diagnosisPayload(),inspection,{'tool/lookup.mjs':SOURCE},[],0,'digest').dependencies;
 expect(runtimeInjection(deps,{},'HTTP_HEADER').missing).toEqual(['余额接口凭证']);
 expect(runtimeInjection(deps,{[deps[0]!.id]:'Bearer fixture'},'HTTP_HEADER').headers).toEqual({authorization:'Bearer fixture'});
 expect(runtimeInjection(deps,{[deps[0]!.id]:'Bearer fixture'},'SCRIPT_CONTEXT').missing.join()).toContain('Script 不支持');
 expect(runtimeInjection(deps,{[deps[0]!.id]:'bad\r\nHost: secret'},'HTTP_HEADER').missing).toHaveLength(1);
 expect(runtimeInjection([{...deps[0]!,binding:{kind:'HTTP_HEADER',name:'Host'}}],{[deps[0]!.id]:'spoof'},'HTTP_HEADER').missing).toHaveLength(1);
});

it('rejects unsafe SDK archives and bounds uploads',()=>{
 expect(()=>supplementFiles('dep-one','../sdk.py',Buffer.from('x'))).toThrow('路径');
 expect(()=>supplementFiles('dep-one','sdk.zip',Buffer.from(zipSync({'../evil.py':strToU8('x')})))).toThrow('路径');
 expect(()=>supplementFiles('dep-one','sdk.py',Buffer.alloc(8*1024*1024+1))).toThrow('8 MB');
 const files=supplementFiles('dep-one','sdk.zip',Buffer.from(zipSync({'sdk/client.py':strToU8('def query(): pass')})));expect(Object.keys(files)).toEqual(['.diagnosis-supplements/dep-one/sdk/client.py']);
});

it('does not follow redirects or retain business response secrets',async()=>{
 let destination=0;const server=createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:'/secret'}).end()}else{destination++;res.end('credential: do-not-save')}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as {port:number};
 try{const result=await probeBusinessInterface(`http://127.0.0.1:${address.port}/redirect`,'GET',{});expect(result.status).toBe('FAILED');expect(destination).toBe(0);const passed=await probeBusinessInterface(`http://127.0.0.1:${address.port}/secret`,'GET',{});expect(passed.status).toBe('PASSED');expect(JSON.stringify(passed)).not.toContain('do-not-save')}finally{await new Promise<void>(r=>server.close(()=>r()))}
});

it.each(['SDK','CONFIG'] as const)('closes source diagnosis after %s file supplementation without leaking runtime values into A2',async(kind)=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'diagnosis-loop-'));const seen:unknown[]=[];
 const analyzer:MigrationAnalyzer=async input=>{seen.push(input);const sdk=Object.keys(input.files).find(p=>p.includes('/client.mjs'));const payload=diagnosisPayload(true,sdk);payload.dependencyAnalysis.dependencies.find(d=>d.owner==='TOOL')!.kind=kind;return {status:'PRODUCED',payload,scanner:{scannerDigest:'a'.repeat(64),coverage:Object.keys(input.files).map(path=>({path,status:'TEXT_INSPECTED'}))}}};
 const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:directory,accessToken:'test',publicDemo:false,migrationAnalyzer:analyzer});const headers={authorization:'Bearer test'};
 try{
  const asset=(await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:Buffer.from(zipSync({'skill/SKILL.md':strToU8(SKILL_MD),'tool/lookup.mjs':strToU8(SOURCE)}))})).json();
  const project=(await app.inject({method:'POST',url:'/api/migrations',headers,payload:{sourceAssetId:asset.assetId,name:'diagnosis'}})).json();const url=`/api/migrations/${project.id}`;
  const first=(await app.inject({method:'POST',url:url+'/inspect',headers})).json();expect(first.dependencyAnalysis.status).toBe('PARTIAL');const sdk=first.dependencyAnalysis.dependencies.find((d:any)=>d.owner==='TOOL');const token=first.dependencyAnalysis.dependencies.find((d:any)=>d.action==='INJECT');
  const configured=await app.inject({method:'PUT',url:url+'/runtime-configuration/'+token.id,headers,payload:{revision:0,value:'Bearer secret-test-value'}});expect(configured.statusCode).toBe(200);
  expect((await app.inject({url:url+'/runtime-configuration',headers})).body).not.toContain('secret-test-value');
  expect((await app.inject({method:'PUT',url:url+'/dependencies/'+token.id+'/data',headers,payload:{revision:0,value:'bad'}})).statusCode).toBe(409);
  expect((await app.inject({method:'POST',url:url+'/dependencies/'+sdk.id+'/file?revision=0&filename=client.mjs',headers:{...headers,'content-type':'application/octet-stream'},payload:Buffer.from('export const query = () => ({balance: 100});')})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:url+'/dependencies/'+sdk.id+'/file?revision=0&filename=client.mjs',headers:{...headers,'content-type':'application/octet-stream'},payload:Buffer.from('stale')})).statusCode).toBe(409);
  const second=(await app.inject({method:'POST',url:url+'/inspect/source',headers})).json();expect(second.dependencyAnalysis.status).toBe('COMPLETE');expect(second.dependencyAnalysis.dependencies.find((d:any)=>d.id===sdk.id).provided).toBe('CONFIRMED');
  expect(JSON.stringify(seen)).not.toContain('secret-test-value');expect(Object.keys((seen.at(-1) as any).files)).toContain(`.diagnosis-supplements/${sdk.id}/client.mjs`);
  expect((await app.inject({method:'PUT',url:url+'/runtime-configuration/'+token.id,headers,payload:{revision:0,value:'stale'}})).statusCode).toBe(409);
  const stored=JSON.parse(await readFile(path.join(directory,'migrations',project.id+'.json'),'utf8'));expect(stored.source.artifactSha256).toBe(asset.artifactSha256);expect(stored.sourceInspection.dependencyAnalysis.status).toBe('COMPLETE');expect(JSON.stringify(stored)).not.toContain('secret-test-value');
 }finally{await app.close();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50})}
});

it('rejects generation of Script with required runtime injection',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'diagnosis-script-boundary-'));
 let generated=false;
 const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:directory,accessToken:'test',publicDemo:false,migrationAnalyzer:async()=>({status:'PRODUCED',payload:diagnosisPayload(),scanner:{scannerDigest:'a'.repeat(64),coverage:[]}}),migrationImplementer:async()=>{generated=true;throw Error('must not run')}});
 const headers={authorization:'Bearer test'};
 try{
  const asset=(await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:Buffer.from(zipSync({'skill/SKILL.md':strToU8(SKILL_MD),'tool/lookup.mjs':strToU8(SOURCE)}))})).json();
  const project=(await app.inject({method:'POST',url:'/api/migrations',headers,payload:{sourceAssetId:asset.assetId,name:'script-boundary'}})).json();const url=`/api/migrations/${project.id}`;
  const inspection=(await app.inject({method:'POST',url:url+'/inspect',headers})).json();
  await app.inject({method:'PUT',url:url+'/tools/'+inspection.tools[0].toolId+'/decision',headers,payload:{baseAssetId:asset.assetId,form:'SCRIPT',language:'node'}});
  const result=await app.inject({method:'POST',url:url+'/generate',headers,payload:{baseAssetId:asset.assetId}});expect(result.statusCode).toBe(409);expect(generated).toBe(false);
 }finally{await app.close();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50})}
});

it('injects MCP credentials independently for each real Tool call without placing them in arguments',async()=>{
 const received:string[]=[];const business=createServer((req,res)=>{received.push(String(req.headers.authorization));res.writeHead(200,{'content-type':'application/json'}).end('{"balance":100}')});await new Promise<void>(r=>business.listen(0,'127.0.0.1',r));const port=(business.address() as {port:number}).port;
 const code=`import http from 'node:http';const server=http.createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;const message=JSON.parse(text||'{}');if(!message.id){res.writeHead(202).end();return}let result={};if(message.method==='initialize')result={protocolVersion:'2025-06-18',serverInfo:{name:'fixture',version:'1'}};if(message.method==='tools/list')result={tools:[{name:'lookup',inputSchema:{type:'object',properties:{account_id:{type:'string'}}}}]};if(message.method==='tools/call'){if(Object.keys(message.params.arguments).join()!=='account_id'){res.writeHead(500).end();return}const response=await fetch('http://127.0.0.1:${port}/balance',{headers:{Authorization:req.headers.authorization}});result={content:[{type:'text',text:JSON.stringify(await response.json())}]}}res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))});server.listen(Number(process.env.PORT),'127.0.0.1');`;
 const service=new LocalMigrationValidationRunner(),tool=toolFixture({name:'lookup',sourcePaths:['mcp/server.mjs'],kind:'MCP',portability:'PORTABLE_MCP'});
 try{for(const credential of ['Bearer first-call','Bearer second-call']){const result=await service.validateMcp({asset:{assetId:'fixture',artifactSha256:'a'.repeat(64)} as any,tool,archive:{'mcp/server.mjs':strToU8(code)},service:{start:['node','mcp/server.mjs']},arguments:{account_id:'A1'},headers:{Authorization:credential}});expect(result.status,JSON.stringify(result)).toBe('PASSED');expect(JSON.stringify(result)).not.toContain(credential)}expect(received).toEqual(['Bearer first-call','Bearer second-call'])}finally{await new Promise<void>(r=>business.close(()=>r()))}
});
