import { taskHttpFixture, standardFiles, encode } from './task-http-fixture.js';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {strToU8,zipSync,unzipSync} from 'fflate';
import {createEvaluationService} from '../src/service/server.js';
import {canonicalSha256} from '../src/shared/json-canonicalization.js';
import {nativeToolCatalogSchema} from '../src/shared/contracts/native-tool-catalog.js';
import {analysisFixture,analyzedTool} from './analysis-fixture.js';
import type {MigrationAnalyzer} from '../src/migration/application/migration-agent-port.js';

const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true})});
function catalog(type='openjiuwen'){
  const body={schemaVersion:'finance.native-tool-catalog.v1',runtime:{type,version:type==='openjiuwen'?'0.1.15':'2.0.3'},
    deploymentId:'fixture-'+type,artifactSha256:'d'.repeat(64),contracts:[{capabilityId:'fixture.query',nativeToolNames:['lookup'],verificationSha256:'e'.repeat(64),
      contract:{inputSchema:{type:'object'},outputSchema:{type:'object'},errorSchema:{type:'object'},semantics:'Synthetic lookup only'},
      constraints:{permissions:['read'],sideEffects:'read',isolation:'per_case'}}]};
  return {...body,catalogDigest:canonicalSha256(body)};
}
it('validates catalog identity and rejects duplicate tool identities',()=>{
  expect(nativeToolCatalogSchema.parse(catalog()).contracts).toHaveLength(1);
  expect(()=>nativeToolCatalogSchema.parse({...catalog(),artifactSha256:'a'.repeat(64)})).toThrow();
  const {catalogDigest:_,...body}=catalog();body.contracts.push(body.contracts[0]!);
  expect(()=>nativeToolCatalogSchema.parse({...body,catalogDigest:canonicalSha256(body)})).toThrow();
});

async function fixture(extra:Record<string,string>={},analyzer?:MigrationAnalyzer){
  const dir=await mkdtemp(path.join(os.tmpdir(),'native-bind-'));dirs.push(dir);
  const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:dir,accessToken:'test',publicDemo:false,
    migrationAnalyzer:analyzer??analysisFixture([analyzedTool({name:'lookup',sourcePaths:['SKILL.md'],portability:'INCOMPLETE'})]),
    migrationImplementer:async()=>{throw Error('Native binding must not generate implementation')}});
  const headers={authorization:'Bearer test'};
  const post=(url:string,payload:unknown)=>app.inject({method:'POST',url,headers,payload});
  const source='---\nname: native-method\nversion: 1.0.0\ndescription: Read synthetic lookup when asked.\nallowed-tools: [lookup]\n---\nCall lookup. On failure report the error; do not invent facts.\n';
  const archive=Buffer.from(zipSync(Object.fromEntries(Object.entries({'SKILL.md':source,...extra}).map(([p,v])=>[p,strToU8(v)]))));
  const asset=(await app.inject({method:'POST',url:'/api/migrations/upload',headers:{...headers,'content-type':'application/zip'},payload:archive})).json();
  const project=(await post('/api/migrations',{sourceAssetId:asset.assetId,name:'Native migration'})).json();
  await post(`/api/migrations/${project.id}/inspect`,{});
  const environments=[];
  for(const type of ['openjiuwen','agentscope'])environments.push((await post('/api/environments',{name:type,type:'runtime_launcher',runtimeType:type,baseUrl:`http://127.0.0.1:1234/${type}/`})).json());
  vi.stubGlobal('fetch',async(url:URL)=>new Response(JSON.stringify(catalog(url.pathname.split('/')[1]))));
  const body={baseAssetId:asset.assetId,tools:['lookup'],acknowledgeContracts:true,targets:environments.map(e=>({environmentId:e.environmentId,catalogDigest:catalog(e.runtimeType).catalogDigest}))};
  return {app,headers,post,asset,project,body,source};
}
it("freezes explicit native contracts separately for two Runtime targets",async()=>{

 const f=await taskHttpFixture();await f.candidate();const requirement={id:'document-reader',name:'read_document',required:true,reason:'Read an isolated workspace document',contract:{inputSchema:{type:'object'},outputSchema:{type:'string'},errorSchema:{type:'object'},semantics:'Read only within this instance'},constraints:{permissions:['workspace.read'],sideEffects:'read',isolation:'per_instance'},preferredTargetCapability:null,consumerTools:['review'],evidence:[{path:'skills/method/SKILL.md',line:4,detail:'Read document'}]};
 for(const runtimeType of ['openjiuwen','agentscope']){const result=await f.buildRequest({runtimeType,requiredCapabilities:[requirement]});expect(result.statusCode,result.body).toBe(200);}
 const requests=(await f.get()).runtimeBuildRequests!;expect(requests.map(r=>r.requirements.target.runtimeType)).toEqual(['openjiuwen','agentscope']);
 expect(requests.every(r=>r.requirements.requiredCapabilities[0]?.contract.semantics===requirement.contract.semantics)).toBe(true);expect((await f.get()).runtimeDelivery).toBeUndefined();

});
it("does not invent native capabilities for an instruction-only task",async()=>{

 const f=await taskHttpFixture();await f.candidate();expect((await f.buildRequest()).statusCode).toBe(200);
 const task=await f.get();expect(task.runtimeBuildRequests![0]!.requirements.requiredCapabilities).toEqual([]);expect(task.builderStatus).toBe('PENDING');expect((await f.start('acceptance')).statusCode).toBe(409);

});
it("keeps previous candidate and requirements immutable when creating a new request",async()=>{

 const f=await taskHttpFixture();await f.candidate();await f.buildRequest({requiredCapabilities:[{id:'document-reader',name:'read_document',required:true,reason:'Read an isolated workspace document',contract:{inputSchema:{type:'object'},outputSchema:{type:'string'},errorSchema:{type:'object'},semantics:'Read only within this instance'},constraints:{permissions:['workspace.read'],sideEffects:'read',isolation:'per_instance'},preferredTargetCapability:null,consumerTools:['review'],evidence:[{path:'skills/method/SKILL.md',line:4,detail:'Read document'}]}]});const first=await f.get();
 f.control.files={...f.files,'shared/rules.json':encode('{"limit":200}')};await f.finish('generate');await f.buildRequest();const next=await f.get();
 expect(next.source).toEqual(first.source);expect(next.candidates[0]).toEqual(first.candidates[0]);expect(next.runtimeBuildRequests![0]).toEqual(first.runtimeBuildRequests![0]);expect(next.runtimeBuildRequests).toHaveLength(2);

});

it("does not allow a caller-supplied native binding to bypass Runtime admission",async()=>{

 const f=await taskHttpFixture();await f.candidate();
 expect((await f.buildRequest({nativeBindings:[]})).statusCode).toBe(400);expect((await f.api('POST',f.url()+'/runtime-deliveries',{result:{status:'SUCCEEDED',nativeBindings:[]},trustReference:'fake'})).statusCode).toBe(400);
 expect((await f.get()).runtimeDelivery).toBeUndefined();

});
it("rejects an incomplete native contract without silently removing the requirement",async()=>{

 const f=await taskHttpFixture();await f.candidate();const req={id:'document-reader',name:'read_document',required:true,reason:'Read an isolated workspace document',contract:{inputSchema:{type:'object'},outputSchema:{type:'string'},errorSchema:{type:'object'},semantics:'Read only within this instance'},constraints:{permissions:['workspace.read'],sideEffects:'read',isolation:'per_instance'},preferredTargetCapability:null,consumerTools:['review'],evidence:[{path:'skills/method/SKILL.md',line:4,detail:'Read document'}]};delete (req as any).contract;
 expect((await f.buildRequest({requiredCapabilities:[req]})).statusCode).toBe(400);expect((await f.get()).runtimeBuildRequests??[]).toHaveLength(0);

});
it("rejects stale candidate references and undeclared native-binding inputs",async()=>{

 const f=await taskHttpFixture();await f.candidate();
 expect((await f.buildRequest({baseCandidateId:'stale-candidate'})).statusCode).toBe(409);
 expect((await f.buildRequest({catalogDigest:'invented',nativeToolNames:['unknown']})).statusCode).toBe(400);
 const req={id:'document-reader',name:'read_document',required:true,reason:'Read an isolated workspace document',contract:{inputSchema:{type:'object'},outputSchema:{type:'string'},errorSchema:{type:'object'},semantics:'Read only within this instance'},constraints:{permissions:['workspace.read'],sideEffects:'read',isolation:'per_instance'},preferredTargetCapability:null,consumerTools:['review'],evidence:[{path:'skills/method/SKILL.md',line:4,detail:'Read document'}]};(req.constraints as any).permissions='host.all';expect((await f.buildRequest({requiredCapabilities:[req]})).statusCode).toBe(400);

});
it("preserves required contracts and constraints in the generic build request",async()=>{

 const f=await taskHttpFixture();await f.candidate();const req={id:'document-reader',name:'read_document',required:true,reason:'Read an isolated workspace document',contract:{inputSchema:{type:'object'},outputSchema:{type:'string'},errorSchema:{type:'object'},semantics:'Read only within this instance'},constraints:{permissions:['workspace.read'],sideEffects:'read',isolation:'per_instance'},preferredTargetCapability:null,consumerTools:['review'],evidence:[{path:'skills/method/SKILL.md',line:4,detail:'Read document'}]};
 expect((await f.buildRequest({requiredCapabilities:[req]})).statusCode).toBe(200);const task=await f.get();
 expect(task.runtimeBuildRequests![0]!.requirements.requiredCapabilities).toEqual([req]);expect(task.runtimeBuildRequests![0]!.requirements).not.toHaveProperty('source');
 expect(task.source.members).toHaveLength(1);expect(task.runtimeDelivery).toBeUndefined();

});
