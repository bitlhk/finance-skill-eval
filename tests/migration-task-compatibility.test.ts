import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { expect, it } from 'vitest';
import { createEvaluationService } from '../src/service/server.js';

it('rejects retired task APIs without modifying stored historical records',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'migration-retired-'));
  const headers={authorization:'Bearer test-private-token'};
  const old=path.join(root,'historical.json');await writeFile(old,'{"schemaVersion":"finance.skill-migration.v2"}');
  const app=await createEvaluationService({dataDirectory:root,rootDirectory:path.resolve('.'),publicDirectory:path.resolve('web-dist'),accessToken:'test-private-token'});
  try{
    for(const url of ['/api/migrations','/api/migration-bundles','/api/migration-tasks/from-legacy/old']){
      const response=await app.inject({method:url.includes('from-legacy')?'POST':'GET',url,headers});
      expect(response.statusCode).toBe(404);
    }
    expect(await readFile(old,'utf8')).toBe('{"schemaVersion":"finance.skill-migration.v2"}');
    expect((await app.inject({url:'/api/migration-tasks',headers})).json()).toEqual([]);
    expect((await app.inject('/api/migration-tasks')).statusCode).toBe(401);
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

it('creates a task from an independent Skill and optional shared files, rejecting unsafe dependency input',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'migration-assets-'));
  const headers={authorization:'Bearer test-private-token'};
  const app=await createEvaluationService({dataDirectory:root,rootDirectory:path.resolve('.'),publicDirectory:path.resolve('web-dist'),accessToken:'test-private-token'});
  try{
    const uploaded=await app.inject({method:'POST',url:'/api/migration-tasks/assets',headers:{...headers,'content-type':'application/zip'},
      payload:Buffer.from(zipSync({'SKILL.md':Buffer.from('---\nname: selected\ndescription: Selected Skill\n---\nRead shared/rules.json.')}))});
    const body={name:'Selected Skill',goal:'Apply shared rules',target:'OpenJiuwen',sourceAssetIds:[uploaded.json().assetId]};
    const created=await app.inject({method:'POST',url:'/api/migration-tasks',headers,payload:{...body,assets:{'shared/rules.json':Buffer.from('{"limit":100}').toString('base64')}}});
    expect(created.statusCode,created.body).toBe(200);expect(created.json().source.members).toHaveLength(1);
    const file=await app.inject({url:'/api/migration-tasks/'+created.json().id+'/file?path=shared/rules.json',headers});expect(file.json().content).toBe('{"limit":100}');
    for(const assets of [{'../escape.py':'YQ=='},{'hidden/SKILL.md':'YQ=='},{'shared/rules.json':'invalid base64'},{'members/member-1/SKILL.md':'YQ=='}]){
      const rejected=await app.inject({method:'POST',url:'/api/migration-tasks',headers,payload:{...body,assets}});expect(rejected.statusCode,rejected.body).toBe(400);
    }
    expect((await app.inject({url:'/api/migration-tasks',headers})).json()).toHaveLength(1);
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
