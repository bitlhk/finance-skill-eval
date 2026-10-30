import { taskHttpFixture, standardFiles, encode } from './task-http-fixture.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { zipSync, strToU8, unzipSync } from 'fflate';
import { createEvaluationService } from '../src/service/server.js';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function setup(publicDemo=false){const dir=await mkdtemp(path.join(os.tmpdir(),'migration-'));dirs.push(dir);return createEvaluationService({dataDirectory:dir,rootDirectory:path.resolve('.'),accessToken:'private-test',publicDemo});}
const headers={authorization:'Bearer private-test'};
it("persists immutable whole-workspace versions and never treats a draft as accepted",async()=>{

 const f=await taskHttpFixture({count:3});const source=(await f.get()).source;const one=await f.candidate();
 f.control.files={...f.files,'shared/rules.json':encode('{"limit":101}')};const two=await f.finish('generate');
 expect(two.source).toEqual(source);expect(two.candidates).toHaveLength(2);expect(two.currentCandidateId).not.toBe(one.currentCandidateId);
 expect(await f.file('shared/rules.json',one.currentCandidateId!)).toBe('{"limit":100}');expect(await f.file('shared/rules.json')).toBe('{"limit":100}');
 expect((await f.api('GET',f.url()+'/export?verified=true')).statusCode).toBe(409);expect((await f.app.inject(f.url())).statusCode).toBe(401);

});
it("public demo cannot read, create or export standard migration tasks",async()=>{

 const f=await taskHttpFixture({publicDemo:true});for(const [method,url] of [['GET','/api/migration-tasks'],['POST','/api/migration-tasks'],['GET','/api/migration-tasks/bundle-a/export']] as const){
 expect((await f.api(method,url)).statusCode).toBe(403);}

});

it("does not load or rewrite historical tasks through the current service",async()=>{

 const f=await taskHttpFixture();const fs=await import('node:fs/promises');const oldPath=path.join(f.root,'migration-tasks','tasks','bundle-00000000-0000-4000-8000-000000000001.json');
 const old=JSON.stringify({schemaVersion:'finance.skill-migration.bundle.v1',id:'bundle-00000000-0000-4000-8000-000000000001',name:'Historical'});
 await fs.mkdir(path.dirname(oldPath),{recursive:true});await fs.writeFile(oldPath,old);
 expect((await f.api('GET','/api/migration-tasks')).json()).toHaveLength(1);
 expect((await f.api('GET','/api/migrations-legacy')).statusCode).toBe(404);expect(await fs.readFile(oldPath,'utf8')).toBe(old);

});
