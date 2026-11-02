import {it,expect,vi} from 'vitest';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHistoricalServiceEnvironmentResolver} from '../src/execution-configuration/historical-service-environment.js';
import {FileExecutionConfigurationRepository} from '../src/execution-configuration/file-execution-configuration-repository.js';
import {executionConfigurationDigest as configurationDigest} from '../src/execution-configuration/execution-configuration.js';
import {EvaluationRunManager} from '../src/service/run-manager.js';
import {runConfigurationSchema} from '../src/service/contracts.js';
import type {Dependency} from '../src/migration/domain/migration-dependency.js';

it('reads historical service bindings without rewriting records and rejects changed or unknown bindings',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'historical-service-'));
 try{
  const id='migration-1234',digest='a'.repeat(64);
  const dependency={id:'service',key:'service',name:'Service',kind:'CONFIG',owner:'RUNTIME',action:'INJECT',
   contractStatus:'KNOWN',sensitive:false,binding:{kind:'SERVICE_ENV',name:'BUSINESS_SERVICE_URL'},toolIds:['lookup'],
   purpose:'Business connection',availability:'MISSING',provided:'NONE',blocking:true,evidence:[],resolvedPaths:[],
   schema:{type:'string'},schemaCompleteness:'COMPLETE'} as Dependency;
  const secret={...dependency,id:'secret',key:'secret',sensitive:true,binding:{kind:'SERVICE_ENV' as const,name:'BUSINESS_TOKEN'}};
  const deps=[dependency,secret];
  const asset={schemaVersion:'finance.skill-eval.skill-asset.v1',assetId:'asset',skillId:'skill',version:'1',
   displayName:'Skill',description:'',sourceType:'zip',artifactSha256:digest,skillFile:'SKILL.md',fileCount:1,createdAt:'now'};
  const record={schemaVersion:'finance.skill-migration.v2',id,name:'Historical',createdAt:'now',source:asset,candidate:asset,
   candidateNotes:'',runs:[],assessment:'NOT_VALIDATED',sourceInspection:{dependencyAnalysis:{dependencies:deps}},
   inspection:{tools:[{toolId:'lookup',name:'lookup'}]},historicalExtra:{preserve:'exact bytes'}};
  await mkdir(path.join(root,'migrations'));const file=path.join(root,'migrations',id+'.json');
  const original=JSON.stringify(record,null,3);await writeFile(file,original);
  const configs=new FileExecutionConfigurationRepository(root,'migration-runtime-config',v=>v===id);
  await configs.saveValue(id,'service','https://business.test',0);const config=await configs.saveValue(id,'secret','PRIVATE_TOKEN',1);
  const ref={migrationId:id,assetDigest:digest,revision:2,configurationDigest:configurationDigest(config,deps)};
  const resolve=createHistoricalServiceEnvironmentResolver(root);
  expect(await resolve(ref,['lookup'])).toEqual({configuration:{BUSINESS_SERVICE_URL:'https://business.test'},secrets:{BUSINESS_TOKEN:'PRIVATE_TOKEN'}});
  await expect(resolve(ref,['unknown'])).rejects.toThrow('未知工具');
  await expect(resolve({...ref,assetDigest:'b'.repeat(64)},['lookup'])).rejects.toThrow('已变化');
  await configs.saveValue(id,'service','https://changed.test',2);
  await expect(resolve(ref,['lookup'])).rejects.toThrow('已变化');
  expect(await readFile(file,'utf8')).toBe(original);
 }finally{await rm(root,{recursive:true,force:true});}
});

it('resolves environment values only in the trusted Runtime transport, keeping the run configuration value-free',async()=>{
 const assetDigest='a'.repeat(64),reference={migrationId:'migration-1234',revision:1,assetDigest,configurationDigest:'config-digest'};
 const launch={assetDigest,toolNames:['lookup'],filePaths:['mcp/server.mjs'],start:['node','mcp/server.mjs'],environmentReference:reference};
 const variant={mode:'skill_version',skillId:'fixture',version:'1.0.0',artifactSha256:assetDigest};
 const configuration=runConfigurationSchema.parse({packId:'fixture',executionModel:{providerId:'test',modelId:'test'},runtime:{type:'runtime_launcher',environmentId:'runtime'},evaluationMode:'candidate_assessment',leftVariant:variant,rightVariant:variant,runtimeBindings:{left:{environmentId:'runtime',skillAssetId:'asset'},right:{environmentId:'runtime',skillAssetId:'asset'}},runtimeMcpBindings:{left:[],right:[launch]}});
 let resolved=0;
 const environment={environmentId:'runtime',type:'runtime_launcher',baseUrl:'http://127.0.0.1:9000/',runtimeType:'openjiuwen',archived:false};
 const resolveLauncher=vi.fn(async(record:unknown)=>{expect(record).toEqual(environment);return {launcher:environment,mcpEnvironmentIds:[],defaultModelId:null};});
 const manager=new EvaluationRunManager({environments:{headers:()=>({}),resolveLauncher},resolveMigrationRuntime:async(id:string)=>{expect(id).toBe('runtime');return environment;},resolveServiceEnvironment:async(ref,names)=>{expect(ref).toEqual(reference);expect(names).toEqual(['lookup']);resolved++;return {configuration:{BUSINESS_SERVICE_URL:'https://private-business.example'},secrets:{}}}} as never);
 (manager as any).skillResolver=async()=>async()=>({});
 const model={providerId:'test',modelId:'test',parameters:{}};
 const pack={variants:{left:variant,right:variant},models:{execution:{left:model,right:model}},cases:[{requiredTools:['lookup']}],metadata:{}};
 const runtime=await (manager as any).runtimeFor(configuration,pack);
 expect((runtime as any).options.environment.candidateMcpServices[0].environment).toEqual({BUSINESS_SERVICE_URL:'https://private-business.example'});
 expect(JSON.stringify(configuration)).not.toContain('private-business');expect(resolved).toBe(1);expect(resolveLauncher).toHaveBeenCalledOnce();
});
