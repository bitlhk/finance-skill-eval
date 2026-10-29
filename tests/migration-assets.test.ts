import { taskHttpFixture, standardFiles, encode } from './task-http-fixture.js';
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
  const {skillRuntimeRequirements}=await import('../src/shared/skill-runtime-requirements.js');
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
it("freezes source and candidate separately and exports unsupported resources without executing them",async()=>{

 const f=await taskHttpFixture({files:{...standardFiles,'helper.py':encode('raise Exception("must not execute")')}});
 const before=await f.get();f.control.files={...f.files,'skills/method/SKILL.md':encode(Buffer.from(f.files['skills/method/SKILL.md']!,'base64').toString()+'\nRevised guidance.')};
 const next=await f.candidate();expect(next.source).toEqual(before.source);expect(next.currentCandidateId).not.toBeNull();
 expect(await f.file('skills/method/SKILL.md')).not.toContain('Revised guidance');
 expect(await f.file('skills/method/SKILL.md',next.currentCandidateId!)).toContain('Revised guidance');
 const archive=await f.exported();expect(Buffer.from(archive['package/helper.py']!).toString()).toBe('raise Exception("must not execute")');
 expect((await f.api('GET',f.url()+'/export?verified=true')).statusCode).toBe(409);
 expect((await f.start('generate',{baseCandidateId:null})).statusCode).toBe(409);

});
