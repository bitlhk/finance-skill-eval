import {it,expect,vi} from 'vitest';
import * as fileStore from '../src/service/file-store.js';
import {SkillStore} from '../src/service/skill-store.js';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {zipSync,strToU8,unzipSync} from 'fflate';
import {createEvaluationService} from '../src/service/server.js';

it('target state uses actual current-run evidence; bad digest fails, retry and refresh work, edits invalidate',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'migration-target-test-')),oldEndpoint=process.env.FINANCE_MIGRATION_NATIVE_ENDPOINT,oldToken=process.env.FINANCE_MIGRATION_NATIVE_TOKEN_FILE;
  await writeFile(path.join(data,'token'),'test-only');
  let bad=true,calls=0;
  let releaseResponse!:()=>void;
  const snapshotRead=new Promise<void>(resolve=>{releaseResponse=resolve;});
  const originalRead=fileStore.readJson;
  let delayedSnapshot=false;
  const reader=vi.spyOn(fileStore,'readJson').mockImplementation(async function<T>(file:string):Promise<T>{
    const value=await originalRead<T>(file);
    if(!delayedSnapshot&&file.includes('migration-target-runs')&&(value as any).status==='RUNNING'){
      delayedSnapshot=true;releaseResponse();
      for(let i=0;i<200;i++){
        if((await originalRead<any>(file)).status!=='RUNNING')break;
        await new Promise(r=>setTimeout(r,10));
      }
      await new Promise(r=>setTimeout(r,10));
    }
    return value;
  });
  const health={hostId:'finance-migration-openjiuwen-reference-v1',version:'0.1.13',hostSha256:'a'.repeat(64),sdkSha256:'65561515ace2d44a1f2448d54fcdf2a2e09eadb8ba5be715836975f3fc4d64ea',modelId:'controlled-protocol-model',modelConfigured:true,sourceKind:'CONTROLLED_SYNTHETIC_BANK',fixturesSha256:'b'.repeat(64),portsSha256:'c'.repeat(64),profiles:{test:{label:'Controlled test',skillId:'reference-readonly',schemaBasis:'Protocol fixture only',tools:[{name:'query_account_balance',description:'read',inputSchema:{type:'object'},outputSchema:{type:'object'}}],cases:[{caseId:'test-normal',label:'normal',expect:'completed',prompt:'read'},{caseId:'test-denied',label:'denied',expect:'denied',prompt:'read'}]}}};
  const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.headers.authorization!=='Bearer test-only'){res.writeHead(401).end('{}');return;}if(req.url==='/health'){res.end(JSON.stringify(health));return;}
    let raw='';for await(const chunk of req)raw+=chunk;const q=JSON.parse(raw),files=Object.fromEntries(JSON.parse(q.skill.canonicalArchive).map((e:any)=>[e.name,Buffer.from(e.content,'base64')])),contract=JSON.parse((files['migration-generated/neutral-contract.json'] as Buffer).toString()),denied=q.case.caseId==='test-denied';calls++;
    if(bad)await snapshotRead;
    const hash=(bytes:any)=>createHash('sha256').update(bytes).digest('hex');
    res.end(JSON.stringify({runId:q.runId,side:q.side,caseId:q.case.caseId,status:denied?'failed':'completed',modelId:q.model.modelId,skillVersion:q.skill.version,output:denied?'':'controlled result',elapsedMs:1,toolCalls:denied?[]:[{name:'query_account_balance',status:'completed'}],loadedSkills:[{skillId:q.skill.skillId,version:q.skill.version}],runtimeIdentityVerified:true,streamCompleted:!denied,error:denied?'AUTHORIZATION_REJECTED':null,metadata:{skillArtifactSha256:bad?'0'.repeat(64):q.skill.artifactSha256,hostSha256:health.hostSha256,sdkSha256:health.sdkSha256,fixturesSha256:health.fixturesSha256,methodSha256:hash(files[contract.method]),resources:contract.resources.map((r:any)=>({path:r.path,visibility:r.visibility,sha256:hash(files[r.path])})),modelCalls:denied?0:2,modelResponses:denied?0:2,businessReads:denied?0:1}}));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));process.env.FINANCE_MIGRATION_NATIVE_ENDPOINT=`http://127.0.0.1:${(server.address() as any).port}/execute`;process.env.FINANCE_MIGRATION_NATIVE_TOKEN_FILE=path.join(data,'token');
  const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:path.join(data,'app'),accessToken:'private',publicDemo:false});const headers={authorization:'Bearer private'};
  const post=async(url:string,payload:any)=>(await app.inject({method:'POST',url,headers,payload}));
  try{
    const asset=(await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:Buffer.from(zipSync({'SKILL.md':strToU8('---\nname: reference-readonly\nversion: 1.0.0\n---\n- `query_account_balance`\nUse `references/rules.md`.'),'references/rules.md':strToU8('Missing is not zero.')}))})).json();
    const project=(await post('/api/migrations',{sourceAssetId:asset.assetId,name:'target-test'})).json();
    const input={runtime:'openjiuwen',intent:'portable_method_and_adapters',baseAssetId:asset.assetId,simulationProfile:'test'};
    expect((await post(`/api/migrations/${project.id}/generate`,input)).statusCode).toBe(409);
    const generated=(await post(`/api/migrations/${project.id}/generate`,{...input,acknowledgeSimulation:true})).json();expect(generated.candidate).toBeTruthy();
    const verify=()=>post(`/api/migrations/${project.id}/verify-target`,{baseAssetId:generated.candidate.assetId});
    const report=async()=>(await app.inject({url:`/api/migrations/${project.id}/report`,headers})).json();
    const wait=async(runId:string)=>{for(let i=0;i<400;i++){const r=await report(),current=r.targetRuns.find((item:{id:string})=>item.id===runId);if(current&&current.status!=='RUNNING')return r;await new Promise(r=>setTimeout(r,10));}throw new Error('timeout');};
    const first=await verify();expect(first.statusCode).toBe(200);expect((await wait(first.json().id)).verification.targetExecution).toBe('FAILED');expect(delayedSnapshot).toBe(true);
    bad=false;const second=await verify();expect(second.statusCode).toBe(200);expect((await wait(second.json().id)).verification.targetExecution).toBe('PASSED');expect((await report()).targetRuns).toHaveLength(2);expect(calls).toBe(3);
    const analysis=(await post(`/api/migrations/${project.id}/analyze`,{})).json();
    expect((await post(`/api/migrations/${project.id}/drafts`,{source:analysis.candidate+'\nNew wording.',notes:'edit',baseAssetId:generated.candidate.assetId,autoVersion:true})).statusCode).toBe(200);
    expect((await report()).verification.targetExecution).toBe('NOT_RUN');expect((await verify()).statusCode).toBe(409);
    const edited=(await report()).project.candidate;
    expect((await post(`/api/migrations/${project.id}/review`,{baseAssetId:edited.assetId,decision:'ACCEPTED',notes:'Controlled API test, not independent human acceptance.'})).statusCode).toBe(200);
    expect((await report()).professionalReview.decision).toBe('ACCEPTED');
    expect((await post(`/api/migrations/${project.id}/review`,{baseAssetId:generated.candidate.assetId,decision:'ACCEPTED',notes:'Stale'})).statusCode).toBe(409);
    const regenerated=(await post(`/api/migrations/${project.id}/generate`,{...input,baseAssetId:edited.assetId,acknowledgeSimulation:true})).json();
    const nextAnalysis=(await post(`/api/migrations/${project.id}/analyze`,{})).json();
    expect(nextAnalysis.candidate).toContain('New wording.');expect(nextAnalysis.source).not.toContain('New wording.');
    expect((await report()).professionalReview).toBeNull();
    const third=await post(`/api/migrations/${project.id}/verify-target`,{baseAssetId:regenerated.candidate.assetId});expect(third.statusCode).toBe(200);
    expect((await wait(third.json().id)).verification.targetExecution).toBe('PASSED');
    const exported=await app.inject({url:`/api/migrations/${project.id}/export`,headers});expect(exported.statusCode).toBe(200);
    const exportedFiles=unzipSync(exported.rawPayload),manifest=JSON.parse(Buffer.from(exportedFiles['migration-manifest.json']!).toString());
    expect(manifest.state).toBe('TARGET_VERIFIED_CANDIDATE');
    expect(Buffer.from(exportedFiles['migration-report.json']!).toString()).not.toContain('controlled result');
    for(const [name,digest] of Object.entries(manifest.files))expect(createHash('sha256').update(exportedFiles[name]!).digest('hex')).toBe(digest);
    const reimport=await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:exported.rawPayload});
    expect(reimport.statusCode).toBe(200);expect(reimport.json().skillId).toBe(regenerated.candidate.skillId);expect(reimport.json().version).toBe(regenerated.candidate.version);
    const restored=await new SkillStore(path.join(data,'app')).readArchive(reimport.json().assetId);
    expect(Object.keys(restored).sort()).toEqual(Object.keys(exportedFiles).sort());
    for(const [name,bytes] of Object.entries(exportedFiles))expect(Buffer.from(restored[name]!)).toEqual(Buffer.from(bytes));
  }finally{releaseResponse();reader.mockRestore();await app.close();await new Promise<void>(r=>server.close(()=>r()));await rm(data,{recursive:true,force:true});if(oldEndpoint===undefined)delete process.env.FINANCE_MIGRATION_NATIVE_ENDPOINT;else process.env.FINANCE_MIGRATION_NATIVE_ENDPOINT=oldEndpoint;if(oldToken===undefined)delete process.env.FINANCE_MIGRATION_NATIVE_TOKEN_FILE;else process.env.FINANCE_MIGRATION_NATIVE_TOKEN_FILE=oldToken;}
});
