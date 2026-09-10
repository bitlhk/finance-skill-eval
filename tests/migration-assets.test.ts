import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { SkillStore } from '../src/service/skill-store.js';
import { createEvaluationService } from '../src/service/server.js';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function directory(){const dir=await mkdtemp(path.join(os.tmpdir(),'migration-assets-'));dirs.push(dir);return dir;}
it('imports legacy lowercase metadata without changing bytes, and rejects ambiguous roots',async()=>{
  const dir=await directory(),store=new SkillStore(dir);await store.initialize();
  const source='name: legacy-method\ndescription: read only\n---\n# Facts\n';
  const record=await store.uploadZip(Buffer.from(zipSync({'skill.md':strToU8(source),'helper.py':strToU8('raise Exception("must not execute")')})));
  expect(record.skillId).toBe('legacy-method');expect(record.version).toBe('0.0.0-upload');
  expect(await store.readSource(record.assetId)).toBe(source);
  expect(Object.keys(await store.readArchive(record.assetId))).toHaveLength(2);
  await expect(store.uploadZip(Buffer.from(zipSync({'skill.md':strToU8(source),'SKILL.md':strToU8(source)})))).rejects.toThrow('ambiguous');
});
it('detects changed on-disk snapshots instead of trusting metadata',async()=>{
  const dir=await directory(),store=new SkillStore(dir);await store.initialize();
  const record=await store.uploadZip(Buffer.from(zipSync({'SKILL.md':strToU8('---\nname: example\nversion: 1\n---\nRead only')})));
  await writeFile(path.join(dir,'skills/assets',record.assetId,'SKILL.md'),'changed');
  await expect(store.readArchive(record.assetId)).rejects.toThrow('integrity');
});
it('edits a separate version, retains unsupported files, rejects stale edits and blocks incomplete export',async()=>{
  const dir=await directory();
  const app=await createEvaluationService({dataDirectory:dir,rootDirectory:path.resolve('.'),accessToken:'private-test',publicDemo:false});
  const headers={authorization:'Bearer private-test'};
  const source='---\nname: readonly-method\nversion: 1.0.0\n---\nRead facts.';
  try {
    const upload=await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},
      payload:Buffer.from(zipSync({'method/skill.md':strToU8(source),'helper.py':strToU8('raise Exception("not executed")')}))});
    expect(upload.statusCode).toBe(200);const asset=upload.json();
    const create=await app.inject({method:'POST',url:'/api/migrations',headers,payload:{sourceAssetId:asset.assetId,name:'Local fixture'}});
    const id=create.json().id;
    const edit=(text:string,baseAssetId=asset.assetId)=>app.inject({method:'POST',url:`/api/migrations/${id}/drafts`,headers,
      payload:{source:text,notes:'Format-only synthetic change',baseAssetId}});
    expect((await edit(source)).statusCode).toBe(409);
    const next=await edit(source.replace('1.0.0','1.0.1'));expect(next.statusCode).toBe(200);
    expect(next.json().source).toEqual(asset);expect(next.json().candidate.fileCount).toBe(2);
    expect(await readFile(path.join(dir,'skills/assets',asset.assetId,'method/skill.md'),'utf8')).toBe(source);
    expect((await edit(source.replace('1.0.0','1.0.2'))).statusCode).toBe(409);
    const analyze=await app.inject({method:'POST',url:`/api/migrations/${id}/analyze`,headers});
    expect(analyze.json().fileInventory.find((f:{name:string})=>f.name==='helper.py').executableReviewRequired).toBe(true);
    expect((await app.inject({url:`/api/migrations/${id}/export`,headers})).statusCode).toBe(409);
    expect((await app.inject({method:'POST',url:`/api/migrations/${id}/releases`,headers})).statusCode).toBe(409);
  } finally {await app.close();}
});
