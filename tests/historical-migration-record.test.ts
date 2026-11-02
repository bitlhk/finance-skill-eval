import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {readHistoricalMigrationRecord} from '../src/execution-configuration/historical-migration-record.js';

const directories:string[]=[];
afterEach(async()=>{for(const root of directories.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(record:unknown){
  const root=await mkdtemp(path.join(os.tmpdir(),'historical-migration-'));directories.push(root);
  await mkdir(path.join(root,'migrations'));
  const file=path.join(root,'migrations','migration-1234.json'),bytes=JSON.stringify(record,null,3);
  await writeFile(file,bytes);
  return {root,file,bytes};
}
function project(id='migration-1234'){
  return {schemaVersion:'finance.skill-migration.v2',id,name:'Example',createdAt:'2026-01-01',
    source:{schemaVersion:'finance.skill-eval.skill-asset.v1',assetId:'asset',skillId:'example',version:'1',
      displayName:'Example',description:'Skill',sourceType:'uploaded',artifactSha256:'a'.repeat(64),
      skillFile:'SKILL.md',fileCount:1,createdAt:'2026-01-01'},
    candidate:null,candidateNotes:'',runs:[],assessment:'NOT_VALIDATED'};
}
it('reads a historical record without rewriting its original bytes',async()=>{
  const {root,file,bytes}=await fixture(project());
  expect(await readHistoricalMigrationRecord(root,'migration-1234')).toEqual(project());
  expect(await readFile(file,'utf8')).toBe(bytes);
});
it('rejects malformed ids and reports missing records',async()=>{
  const {root}=await fixture(project());
  await expect(readHistoricalMigrationRecord(root,'../outside')).rejects.toMatchObject({statusCode:400});
  await expect(readHistoricalMigrationRecord(root,'migration-5678')).rejects.toMatchObject({statusCode:404});
});
it('rejects a persisted identity that does not match the requested file',async()=>{
  const {root}=await fixture(project('migration-5678'));
  await expect(readHistoricalMigrationRecord(root,'migration-1234')).rejects.toThrow('记录 ID 与请求不一致');
});
it('does not upgrade or rewrite older records when resolving service bindings',async()=>{
  const {root,file,bytes}=await fixture({...project(),schemaVersion:'finance.skill-migration.v0.1',targetRuns:['run-1']});
  await expect(readHistoricalMigrationRecord(root,'migration-1234')).rejects.toMatchObject({statusCode:410});
  expect(await readFile(file,'utf8')).toBe(bytes);
});
it('validates record contents even when the version discriminator is correct',async()=>{
  const {root}=await fixture({schemaVersion:'finance.skill-migration.v2',id:'migration-1234'});
  await expect(readHistoricalMigrationRecord(root,'migration-1234')).rejects.toMatchObject({name:'ZodError'});
});
