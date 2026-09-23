import {it,expect,vi} from 'vitest';
import {strToU8} from 'fflate';
import {createServer} from 'node:http';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {analyzeDependencies} from '../src/migration/infrastructure/migration-dependencies.js';
import {serviceEnvironment,runtimeInjection,migrationExecutionConfig,MigrationRuntimeConfig,configurationDigest} from '../src/migration/infrastructure/migration-runtime-config.js';
import {runtimeToolConfigTemplate,validateAgentRuntimeDelivery} from '../src/migration/domain/migration-delivery-contract.js';
import {inspectionFixture,toolFixture} from './analysis-fixture.js';
import {TechnicalValidationService} from '../src/migration/infrastructure/migration-technical-validator.js';
import {MigrationStore} from '../src/migration/migration-store.js';
import {EvaluationRunManager} from '../src/service/run-manager.js';
import {runConfigurationSchema} from '../src/service/contracts.js';
import {buildMigrationPlan} from '../src/migration/domain/migration-model.js';

function fixture(name='BUSINESS_SERVICE_URL'){
 const tool=toolFixture({name:'lookup',sourcePaths:['lookup.mjs'],kind:'MCP'}),inspection=inspectionFixture([tool]);
 const source='/** @type {string} */ const service_url = runtime.service_url; fetch(service_url);',ref={toolName:'lookup',path:'lookup.mjs',snippet:'fetch(service_url)'};
 const payload={dependencyAnalysis:{dependencies:[{key:'service-url',name:'业务服务地址',kind:'CONFIG',owner:'RUNTIME',action:'INJECT',contractStatus:'KNOWN',sensitive:false,binding:{kind:'SERVICE_ENV',name},purpose:'业务接口的部署地址',availability:'MISSING',references:[ref],schema:{type:'string'},schemaCompleteness:'COMPLETE',schemaEvidence:[{path:'lookup.mjs',snippet:'/** @type {string} */'}]}],chains:[{toolName:'lookup',nodes:[{id:'call',title:'请求',detail:'请求业务服务',dependencyKeys:['service-url'],evidence:[ref]}]}]}};
 inspection.dependencyAnalysis=analyzeDependencies(payload,inspection,{'lookup.mjs':source},[],0,'materials');
 const deps=inspection.dependencyAnalysis.dependencies,dep=deps[0]!;
 const decisions=[{toolId:tool.toolId,form:'MCP' as const,language:'node',reason:'',baseAssetId:'asset',decidedAt:'now'}];
 return {tool,inspection,deps,dep,decisions};
}

it('diagnoses a startup contract without real values and keeps it out of Headers, arguments and context',()=>{
 const {inspection,deps,dep,tool,decisions}=fixture();
 expect(inspection.dependencyAnalysis!.status).toBe('COMPLETE');
 expect(buildMigrationPlan(inspection,decisions,'asset').items[0]!.blockingReasons).toEqual([]);
 expect(runtimeInjection(deps,{},'HTTP_HEADER')).toEqual({headers:{},context:{},missing:[]});
 expect(migrationExecutionConfig(deps,{},[tool]).context).toEqual({});
 expect(()=>serviceEnvironment(deps,{})).toThrow('请先填写服务配置');
 const values={[dep.id]:'https://business.example/v1'};
 expect(serviceEnvironment(deps,values)).toEqual({BUSINESS_SERVICE_URL:values[dep.id]});
 const template=runtimeToolConfigTemplate(inspection,decisions);
 expect(template.requiredEnvironment).toEqual([]);expect(template.serviceEnvironment[0]!.name).toBe('BUSINESS_SERVICE_URL');
 expect(JSON.stringify(template)).not.toContain(values[dep.id]);
 const report={tools:[{toolId:tool.toolId,compilePassed:true,contractPassed:true,runtimeBindings:[],serviceEnvironment:[{key:dep.key,name:dep.binding!.name}]}]};
 expect(validateAgentRuntimeDelivery(report,inspection,decisions)).toEqual([]);
 report.tools[0]!.serviceEnvironment[0]!.name='WRONG';expect(validateAgentRuntimeDelivery(report,inspection,decisions).join()).toContain('服务环境变量');
});

it('rejects reserved environment names, non-scalar values and conflicting shared-service variables',()=>{
 expect(fixture('PORT').inspection.dependencyAnalysis!.status).toBe('PARTIAL');
 const {deps,dep}=fixture();
 expect(()=>serviceEnvironment(deps,{[dep.id]:{url:'x'}})).toThrow('格式不合法');
 expect(()=>serviceEnvironment([...deps,{...dep,id:'another'}],{[dep.id]:'first',another:'second'})).toThrow('冲突');
 expect(serviceEnvironment([{...dep,schema:{type:'integer'},binding:{kind:'SERVICE_ENV',name:'BUSINESS_TIMEOUT_MS'}}],{[dep.id]:3000})).toEqual({BUSINESS_TIMEOUT_MS:'3000'});
});

it('resolves a revision-bound reference for selected tools and rejects changed configuration',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'service-env-reference-'));
 const {inspection,dep,deps}=fixture(),id='migration-1234',assetDigest='a'.repeat(64);
 try{
  await mkdir(path.join(root,'migrations'));
  const configs=new MigrationRuntimeConfig(root),config=await configs.save(id,dep,'https://business.example',0);
  const ref={migrationId:id,revision:config.revision,assetDigest,configurationDigest:configurationDigest(config,deps)};
  await writeFile(path.join(root,'migrations',id+'.json'),JSON.stringify({id,schemaVersion:'finance.skill-migration.v2',source:{artifactSha256:'b'.repeat(64)},candidate:{artifactSha256:assetDigest},inspection,sourceInspection:inspection,runs:[{jobId:'job',candidateDigest:assetDigest,runtimeConfigurationDigest:ref.configurationDigest,declaredPlan:{configuration:{runtime:{type:'runtime_launcher',environmentId:'runtime'}}}}]}));
  const runtime={environmentId:'runtime',type:'runtime_launcher',runtimeType:'openjiuwen'};
  const store=new MigrationStore(root,{} as never,{} as never,{get:()=>({status:'failed'})} as never,{} as never,undefined,undefined,undefined,{get:async()=>runtime} as never);
  expect(await store.resolveServiceEnvironment(ref,['lookup'])).toEqual({configuration:{BUSINESS_SERVICE_URL:'https://business.example'},secrets:{}});
  await expect(store.resolveServiceEnvironment(ref,['unknown'])).rejects.toThrow('未知工具');
  expect((await store.report(id)).openJiuwenValidations[0]!.current).toBe(true);
  await configs.save(id,dep,'https://changed.example',1);
  expect((await store.report(id)).openJiuwenValidations[0]!.current).toBe(false);
  await expect(store.resolveServiceEnvironment(ref,['lookup'])).rejects.toThrow('已变化');
 }finally{await rm(root,{recursive:true,force:true})}
});

it('resolves environment values only in the trusted Runtime transport, keeping the run configuration value-free',async()=>{
 const assetDigest='a'.repeat(64),reference={migrationId:'migration-1234',revision:1,assetDigest,configurationDigest:'config-digest'};
 const launch={assetDigest,toolNames:['lookup'],filePaths:['mcp/server.mjs'],start:['node','mcp/server.mjs'],environmentReference:reference};
 const variant={mode:'skill_version',skillId:'fixture',version:'1.0.0',artifactSha256:assetDigest};
 const configuration=runConfigurationSchema.parse({packId:'fixture',executionModel:{providerId:'test',modelId:'test'},runtime:{type:'runtime_launcher',environmentId:'runtime'},evaluationMode:'candidate_assessment',leftVariant:variant,rightVariant:variant,runtimeBindings:{left:{environmentId:'runtime',skillAssetId:'asset'},right:{environmentId:'runtime',skillAssetId:'asset'}},runtimeMcpBindings:{left:[],right:[launch]}});
 let resolved=0;
 const manager=new EvaluationRunManager({environments:{headers:()=>({})},resolveMigrationRuntime:async()=>({type:'runtime_launcher',baseUrl:'http://127.0.0.1:9000/',runtimeType:'openjiuwen'}),resolveServiceEnvironment:async(ref,names)=>{expect(ref).toEqual(reference);expect(names).toEqual(['lookup']);resolved++;return {configuration:{BUSINESS_SERVICE_URL:'https://private-business.example'},secrets:{}}}} as never);
 (manager as any).skillResolver=async()=>async()=>({});
 const model={providerId:'test',modelId:'test',parameters:{}};
 const pack={variants:{left:variant,right:variant},models:{execution:{left:model,right:model}},cases:[{requiredTools:['lookup']}],metadata:{}};
 const runtime=await (manager as any).runtimeFor(configuration,pack);
 expect((runtime as any).options.environment.candidateMcpServices[0].environment).toEqual({BUSINESS_SERVICE_URL:'https://private-business.example'});
 expect(JSON.stringify(configuration)).not.toContain('private-business');expect(resolved).toBe(1);
});

it('starts MCP with process-scoped service configuration and invokes the real business endpoint',async()=>{
 const seen:Array<{path:string;header?:string}>=[];
 const business=createServer((req,res)=>{seen.push({path:req.url!,header:req.headers['x-service-url'] as string|undefined});res.writeHead(200,{'content-type':'application/json'}).end('{"balance":100}')});
 await new Promise<void>(resolve=>business.listen(0,'127.0.0.1',resolve));
 const port=(business.address() as {port:number}).port;
 const code=`import http from 'node:http';http.createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;const m=JSON.parse(text||'{}');if(!m.id){res.writeHead(202).end();return}let result={};if(m.method==='initialize')result={protocolVersion:'2025-06-18',serverInfo:{name:'fixture',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'lookup',inputSchema:{type:'object',properties:{account_id:{type:'string'}}}}]};if(m.method==='tools/call'){if(Object.keys(m.params.arguments).join()!=='account_id')throw Error('unexpected arguments');const response=await fetch(process.env.BUSINESS_SERVICE_URL+'/balance');result={content:[{type:'text',text:JSON.stringify(await response.json())}]}}res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}))}).listen(Number(process.env.PORT),'127.0.0.1');`;
 const service=new TechnicalValidationService(),{tool}=fixture(),before=process.env.BUSINESS_SERVICE_URL;
 try{
  for(const prefix of ['first','second']){
   const value=`http://127.0.0.1:${port}/${prefix}`;
   const result=await service.validateMcp({asset:{assetId:'fixture',artifactSha256:'a'.repeat(64)} as never,tool,archive:{'mcp/server.mjs':strToU8(code)},service:{start:['node','mcp/server.mjs']},environment:{BUSINESS_SERVICE_URL:value},arguments:{account_id:'A1'}});
   expect(result.status,JSON.stringify(result)).toBe('PASSED');expect(JSON.stringify(result)).not.toContain(value);
  }
  expect(seen).toEqual([{path:'/first/balance',header:undefined},{path:'/second/balance',header:undefined}]);
  expect(process.env.BUSINESS_SERVICE_URL).toBe(before);
 }finally{await new Promise<void>(resolve=>business.close(()=>resolve()))}
});
