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
    const automatic=await app.inject({method:'POST',url:'/api/migration-tasks',headers,payload:{sourceAssetIds:[uploaded.json().assetId]}});
    expect(automatic.statusCode,automatic.body).toBe(200);
    expect(automatic.json()).toMatchObject({name:'selected 迁移',goal:expect.stringContaining('Selected Skill')});
    const zip=Buffer.from(zipSync({'SKILL.md':Buffer.from('---\nname: zip-skill\ndescription: 从压缩包自动识别\n---\nRead inputs.')}));
    const configuration={environmentId:'test-env',modelId:'test-model',timeoutMs:10000,harnessTools:[]};
    const direct=await app.inject({method:'POST',url:'/api/migration-tasks/upload?'+new URLSearchParams({configuration:JSON.stringify(configuration)}),headers:{...headers,'content-type':'application/zip'},payload:zip});
    expect(direct.statusCode,direct.body).toBe(200);expect(direct.json()).toMatchObject({name:'zip-skill 迁移',configuration});
    const before=(await app.inject({url:'/api/migration-tasks',headers})).json().length;
    const lowercase=await app.inject({method:'POST',url:'/api/migration-tasks/upload',headers:{...headers,'content-type':'application/zip'},payload:Buffer.from(zipSync({'skill.md':Buffer.from('---\nname: lowercase\ndescription: Input case remains strict\n---\nRead inputs.')}))});
    expect(lowercase.statusCode).toBe(400);expect(lowercase.json().message).toContain('SKILL.md');
    expect((await app.inject({url:'/api/migration-tasks',headers})).json()).toHaveLength(before);

  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});


it('imports more than ten Skills through both whole-project ZIP and existing-asset selection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'migration-many-skills-'));
  const headers = {authorization:'Bearer test-private-token'};
  const app = await createEvaluationService({dataDirectory:root,rootDirectory:path.resolve('.'),publicDirectory:path.resolve('web-dist'),accessToken:'test-private-token'});
  try {
    const files = Object.fromEntries(Array.from({length:11}, (_, i) => [`skills/s${i}/SKILL.md`, Buffer.from(`---\nname: s${i}\ndescription: Skill ${i}\n---\nRead inputs.`)]));
    const direct = await app.inject({method:'POST',url:'/api/migration-tasks/upload',headers:{...headers,'content-type':'application/zip'},payload:Buffer.from(zipSync(files))});
    expect(direct.statusCode, direct.body).toBe(200);
    expect(direct.json().source.members).toHaveLength(11);
    const sourceAssetIds: string[] = [];
    for (const file of Object.values(files)) {
      const uploaded = await app.inject({method:'POST',url:'/api/migration-tasks/assets',headers:{...headers,'content-type':'application/zip'},payload:Buffer.from(zipSync({'SKILL.md':file}))});
      expect(uploaded.statusCode, uploaded.body).toBe(200);
      sourceAssetIds.push(uploaded.json().assetId);
    }
    const selected = await app.inject({method:'POST',url:'/api/migration-tasks',headers,payload:{sourceAssetIds}});
    expect(selected.statusCode, selected.body).toBe(200);
    expect(selected.json().source.members).toHaveLength(11);
  } finally { await app.close(); await rm(root,{recursive:true,force:true}); }
});
