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
it('binds explicit admitted contracts, freezes both targets and preserves source',async()=>{
  const f=await fixture();try{
    // The fixture analyzer publishes object schemas; the admitted schemas match.
    const result=await f.post(`/api/migrations/${f.project.id}/native-candidate`,f.body);
    expect(result.statusCode,result.body).toBe(200);
    const p=result.json();expect(p.candidate.artifactSha256).not.toBe(f.asset.artifactSha256);
    expect(p.nativeBindings.bindings.targets).toHaveLength(2);
    expect(p.source.artifactSha256).toBe(f.asset.artifactSha256);
    const archive=await f.app.inject({url:`/api/migrations/${p.id}/export`,headers:f.headers});
    expect(archive.statusCode).toBe(200);
    const files=unzipSync(archive.rawPayload);
    const bindings=JSON.parse(Buffer.from(files['references/finance-native-bindings.txt']!).toString());
    expect(bindings.tools[0].contractDigest).toBe(canonicalSha256(catalog().contracts[0]!.contract));
    const report=(await f.app.inject({url:`/api/migrations/${p.id}/report`,headers:f.headers})).json();
    expect(report.workflow.stage).toBe('EVALUATE');expect(report.verification.targetExecution).toBe('NOT_RUN');
  }finally{await f.app.close()}
});
it('rejects stale catalogs, omitted tools, unknown owners and executable uploads',async()=>{
  const f=await fixture({'scripts/tool.py':'print(1)'});try{
    const url=`/api/migrations/${f.project.id}/native-candidate`;
    expect((await f.app.inject({method:'POST',url,payload:f.body})).statusCode).toBe(401);
    expect((await f.post(url,{...f.body,targets:f.body.targets.map(t=>({...t,catalogDigest:'0'.repeat(64)}))})).statusCode).toBe(409);
    expect((await f.post(url,{...f.body,tools:['other']})).statusCode).toBe(409);
    const result=await f.post(url,f.body);expect(result.statusCode).toBe(409);
    expect(result.body).toMatch(/上传代码|规范错误/);
  }finally{await f.app.close()}
});
it('does not discard an explicit runtime dependency when binding an admitted tool',async()=>{
  const declaration='Tool lookup requires API_TOKEN from the runtime before querying.';
  const base=analysisFixture([analyzedTool({name:'lookup',sourcePaths:['SKILL.md'],portability:'INCOMPLETE'})]);
  const analyzer:MigrationAnalyzer=async input=>{
    const result=await base(input),payload=result.payload as Record<string,unknown>;
    return {...result,payload:{...payload,dependencyAnalysis:{
      ...(payload.dependencyAnalysis as Record<string,unknown>),dependencies:[{
        key:'tool-token',name:'Tool token',kind:'CONFIG',owner:'RUNTIME',action:'INJECT',
        contractStatus:'KNOWN',sensitive:true,binding:{kind:'SERVICE_ENV',name:'API_TOKEN'},
        purpose:'Explicit source requirement',blocking:true,availability:'UNKNOWN',
        references:[{toolName:'lookup',path:'references/connection.txt',snippet:declaration}],
      }],
    }}};
  };
  const f=await fixture({'references/connection.txt':declaration},analyzer);
  try{
    const result=await f.post(`/api/migrations/${f.project.id}/native-candidate`,f.body);
    expect(result.statusCode).toBe(409);expect(result.body).toContain('额外运行依赖');
    const report=(await f.app.inject({url:`/api/migrations/${f.project.id}/report`,headers:f.headers})).json();
    expect(report.project.candidate).toBeNull();
  }finally{await f.app.close()}
});
