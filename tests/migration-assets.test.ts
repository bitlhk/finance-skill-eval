import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { strToU8, zipSync, unzipSync } from 'fflate';
import { SkillStore } from '../src/service/skill-store.js';
import { createEvaluationService } from '../src/service/server.js';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function directory(){const dir=await mkdtemp(path.join(os.tmpdir(),'migration-assets-'));dirs.push(dir);return dir;}
it('packages the fact-check fixture deterministically and refuses overwrites',async()=>{
  const dir=await directory(),first=path.join(dir,'first.zip'),second=path.join(dir,'second.zip');
  const script=path.resolve('examples/fact-check-demo/package.mjs');
  const run=(out:string)=>spawnSync(process.execPath,[script,out],{encoding:'utf8'});
  expect(run(first).status).toBe(0);expect(run(second).status).toBe(0);
  const bytes=await readFile(first);
  expect(await readFile(second)).toEqual(bytes);
  expect(Object.keys(unzipSync(bytes))).toEqual(['SKILL.md']);
  expect(run(first).status).not.toBe(0);expect(await readFile(first)).toEqual(bytes);
});
it('imports the reproducible no-tool fact-check sample without changing its method',async()=>{
  const {skillRuntimeRequirements}=await import('../src/service/skill-runtime-requirements.js');
  const source=await readFile(new URL('../examples/fact-check-demo/SKILL.md',import.meta.url),'utf8');
  const store=new SkillStore(await directory());await store.initialize();
  const record=await store.uploadZip(Buffer.from(zipSync({'SKILL.md':strToU8(source)})));
  expect(record.skillId).toBe('fact-check-demo');expect(record.version).toBe('0.1.0');
  expect(await store.readSource(record.assetId)).toBe(source);
  expect(skillRuntimeRequirements(source,[])).toEqual([]);
  expect(()=>skillRuntimeRequirements(source,['account_balance_query'])).toThrow('案例工具');
});
it('imports legacy lowercase metadata without changing bytes, and rejects ambiguous roots',async()=>{
  const dir=await directory(),store=new SkillStore(dir);await store.initialize();
  const source='name: legacy-method\ndescription: read only\n---\n# Facts\n';
  const record=await store.uploadZip(Buffer.from(zipSync({'skill.md':strToU8(source),'helper.py':strToU8('raise Exception("must not execute")')})));
  expect(record.skillId).toBe('legacy-method');expect(record.version).toBe('0.0.0-upload');
  expect(await store.readSource(record.assetId)).toBe(source);
  expect(Object.keys(await store.readArchive(record.assetId))).toHaveLength(2);
  await expect(store.uploadZip(Buffer.from(zipSync({'skill.md':strToU8(source),'SKILL.md':strToU8(source)})))).rejects.toThrow('多个 Skill 入口');
});
it('detects changed on-disk snapshots instead of trusting metadata',async()=>{
  const dir=await directory(),store=new SkillStore(dir);await store.initialize();
  const record=await store.uploadZip(Buffer.from(zipSync({'SKILL.md':strToU8('---\nname: example\nversion: 1\n---\nRead only')})));
  await writeFile(path.join(dir,'skills/assets',record.assetId,'SKILL.md'),'changed');
  await expect(store.readArchive(record.assetId)).rejects.toThrow('摘要不一致');
});
it('edits a separate version, retains unsupported files and exports them inertly without claiming release',async()=>{
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
    const exported=await app.inject({url:`/api/migrations/${id}/export`,headers});expect(exported.statusCode).toBe(200);
    const archive=unzipSync(exported.rawPayload);
    expect(Buffer.from(archive['helper.py']!).toString()).toBe('raise Exception("not executed")');
    expect(archive['migration-manifest.json']).toBeUndefined();
    expect(archive['migration-report.json']).toBeUndefined();
    expect((await app.inject({method:'POST',url:`/api/migrations/${id}/releases`,headers})).statusCode).toBe(409);
  } finally {await app.close();}
});
