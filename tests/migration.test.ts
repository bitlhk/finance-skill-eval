import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { zipSync, strToU8, unzipSync } from 'fflate';
import { createEvaluationService } from '../src/service/server.js';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function setup(publicDemo=false){const dir=await mkdtemp(path.join(os.tmpdir(),'migration-'));dirs.push(dir);return createEvaluationService({dataDirectory:dir,rootDirectory:path.resolve('.'),accessToken:'private-test',publicDemo});}
const headers={authorization:'Bearer private-test'};
it('persists immutable source/candidate, keeps drafts unvalidated and blocks release',async()=>{
  const app=await setup();
  try {
    const upload=async(version:string)=>{
      const r=await app.inject({url:'/api/skills/upload',method:'POST',headers:{...headers,'content-type':'application/zip'},
        payload:Buffer.from(zipSync({'SKILL.md':strToU8(`---\nname: synthetic-migration\nversion: ${version}\n---\nDescribe known assets; never write.`)}))});
      expect(r.statusCode).toBe(200);return r.json();
    };
    const a=await upload('1.0.0'),b=await upload('1.0.1');
    const created=await app.inject({url:'/api/migrations',method:'POST',headers,payload:{sourceAssetId:a.assetId,name:'Synthetic fixture only'}});
    expect(created.statusCode).toBe(200);const id=created.json().id;
    const attach=(assetId:string)=>app.inject({url:`/api/migrations/${id}/candidates`,method:'POST',headers,payload:{assetId,notes:'Keep behavior'}});
    expect((await attach(a.assetId)).statusCode).toBe(409);
    const attached=await attach(b.assetId);expect(attached.statusCode).toBe(200);expect(attached.json().source).toEqual(a);
    const analysis=await app.inject({url:`/api/migrations/${id}/analyze`,method:'POST',headers});
    expect(analysis.json().uploadedScriptsExecuted).toBe(false);expect(analysis.json().unresolved).toContain('BUILDER_JAVA_HOST_ADAPTER_NOT_CONNECTED');
    const report=await app.inject({url:`/api/migrations/${id}/report`,headers});expect(report.json().project.assessment).toBe('NOT_VALIDATED');
    expect((await app.inject({url:`/api/migrations/${id}/releases`,method:'POST',headers,payload:{validated:true}})).statusCode).toBe(409);
    const exported=await app.inject({url:`/api/migrations/${id}/export`,headers});expect(exported.statusCode).toBe(200);
    const files=unzipSync(exported.rawPayload);expect(JSON.parse(Buffer.from(files['migration-manifest.json']!).toString()).state).toBe('DRAFT_NOT_VALIDATED');
    expect((await app.inject({url:'/api/migrations'})).statusCode).toBe(401);
  }finally{await app.close();}
});
it('public demo cannot read, create or export migration projects',async()=>{
  const app=await setup(true);
  try{for(const [method,url] of [['GET','/api/migrations'],['POST','/api/migrations'],['GET','/api/migrations/migration-a/export']] as const){
    expect((await app.inject({method,url,headers})).statusCode).toBe(403);
  }}finally{await app.close();}
});
