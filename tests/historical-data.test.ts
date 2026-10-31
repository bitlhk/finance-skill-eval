import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { HistoryStore } from '../src/service/history-store.js';
import { createEvaluationService } from '../src/service/server.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eval-history-')); roots.push(root);
  const id = 'bundle-aabb', candidate = 'candidate-ccdd';
  const put = async (name: string, value: unknown) => { const file = path.join(root, name); await mkdir(path.dirname(file), {recursive:true}); await writeFile(file, JSON.stringify(value)); return file; };
  const task = { schemaVersion:'finance.skill-migration.bundle.v1', id, name:'历史采购审核', goal:'审核采购预算', target:'旧 Runtime', createdAt:'2026-10-19T00:00:00Z',
    source:{digest:'a'.repeat(64),members:[{id:'skill-1',skillId:'purchase',skillFile:'SKILL.md'}]}, analysis:{summary:'历史分析结果'},
    currentCandidateId:candidate, candidates:[{id:candidate,summary:'历史候选',createdAt:'2026-10-19T01:00:00Z'}],
    attempts:[{id:'attempt-old',kind:'ACCEPT',status:'RUNNING',message:'历史进度',startedAt:'2026-10-19T01:00:00Z'}],
    runs:[{id:'run-old',status:'PASSED',cases:[{id:'case-1',passed:true,reason:'当时结果符合要求',evidence:{output:'历史证据'}}]}] };
  const original = await put('migration-bundles/tasks/'+id+'.json', task);
  const source = await put(`migration-bundles/snapshots/${id}/source.json`, {digest:'a'.repeat(64),files:{'SKILL.md':Buffer.from('# 原始 Skill').toString('base64')}});
  const generated = await put(`migration-bundles/snapshots/${id}/${candidate}.json`, {digest:'b'.repeat(64),files:{'SKILL.md':Buffer.from('# 历史候选').toString('base64'),'image.bin':'/w=='}});
  const env = await put('environments/env-old.json', {environmentId:'env-old',name:'旧环境',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:'http://127.0.0.1:9/',
    delivery:{evalConformance:{status:'PASSED',instanceSchemaVersion:'finance.skill-eval.runtime-instance.v2',bundleDigest:'a'.repeat(64)}}});
  await put('migrations/migration-old.json', {schemaVersion:'finance.skill-migration.v1',id:'migration-old',name:'更早的迁移记录'});
  const files = [original,source,generated,env];
  const before = await Promise.all(files.map(file=>readFile(file)));
  return {root,id,candidate,task,put,original,source,generated,env,files,before,history:new HistoryStore(root)};
}

it('lists all historical origins, reads analysis/evidence/files and exports unchanged originals',async()=>{
  const f = await fixture();
  expect((await f.history.list('tasks')).map(r=>r.origin).sort()).toEqual(['bundles','migrations']);
  const detail=await f.history.get('bundles',f.id);
  expect(detail).toMatchObject({readOnly:true,record:f.task});
  expect(detail.reason).toContain('无法安全恢复');
  expect(detail.record?.attempts).toEqual(f.task.attempts);
  expect(detail.snapshots).toHaveLength(2);
  expect((await f.history.snapshot('bundles',f.id,'source')).files).toEqual(['SKILL.md']);
  expect((await f.history.file('bundles',f.id,'source','SKILL.md')).content).toBe('# 原始 Skill');
  expect((await f.history.file('bundles',f.id,f.candidate,'SKILL.md')).content).toBe('# 历史候选');
  expect((await f.history.file('bundles',f.id,f.candidate,'image.bin')).content).toContain('二进制');
  const archive=unzipSync(await f.history.archive('bundles',f.id));
  expect(Buffer.from(archive['record.json']!)).toEqual(f.before[0]);
  expect(Buffer.from(archive['snapshots/source.json']!)).toEqual(f.before[1]);
  expect(JSON.parse(Buffer.from(archive['history-manifest.json']!).toString()).readOnly).toBe(true);
  expect((await f.history.list('environments'))[0]).toMatchObject({id:'env-old',readOnly:true});
  expect((await f.history.get('environments','env-old')).record?.delivery).toEqual(JSON.parse(f.before[3]!.toString()).delivery);
  expect(await Promise.all(f.files.map(file=>readFile(file)))).toEqual(f.before);
});

it('reports damaged records and missing snapshots instead of dropping them',async()=>{
  const f=await fixture();
  await writeFile(f.original,'{broken json');
  expect((await f.history.list('tasks')).find(r=>r.id===f.id)?.issue).toContain('损坏');
  expect((await f.history.get('bundles',f.id)).record).toBeNull();
  expect(Buffer.from(unzipSync(await f.history.archive('bundles',f.id))['record.json']!).toString()).toBe('{broken json');
  await writeFile(f.original,JSON.stringify(f.task)); await rm(f.generated);
  expect((await f.history.get('bundles',f.id)).snapshotIssue).toContain(f.candidate);
  await expect(f.history.snapshot('bundles',f.id,f.candidate)).rejects.toMatchObject({statusCode:404});
});

it('never treats current records or matching IDs as historical execution targets',async()=>{
  const f=await fixture();
  await f.put('migration-tasks/tasks/'+f.id+'.json',{...f.task,schemaVersion:'finance.skill-migration.task.v1',attempts:[],runs:[]});
  expect(await f.history.blockedTask(f.id)).toBeNull();
  expect((await f.history.list('tasks')).filter(r=>r.id===f.id)).toHaveLength(1);
  await expect(f.history.get('tasks',f.id)).rejects.toMatchObject({statusCode:409});
  await expect(f.history.get('bundles','../../escape')).rejects.toMatchObject({statusCode:400});
  await expect(f.history.snapshot('bundles',f.id,'../../escape')).rejects.toMatchObject({statusCode:404});
  await expect(f.history.file('bundles',f.id,'source','../../escape')).rejects.toMatchObject({statusCode:404});
});

it('refuses redirected snapshot directories before disclosing their contents',async()=>{
  const f=await fixture();
  const outside=await mkdtemp(path.join(os.tmpdir(),'history-outside-')); roots.push(outside);
  await writeFile(path.join(outside,'source.json'),JSON.stringify({files:{secret:'c2VjcmV0'}}));
  await rm(path.dirname(f.source),{recursive:true});
  await symlink(outside,path.dirname(f.source),process.platform==='win32'?'junction':'dir');
  const detail=await f.history.get('bundles',f.id);
  expect(detail.snapshots).toEqual([]); expect(detail.snapshotIssue).toBeTruthy();
  await expect(f.history.snapshot('bundles',f.id,'source')).rejects.toMatchObject({statusCode:404});
});

it('requires authentication and rejects every historical mutation without model calls or data writes',async()=>{
  const f=await fixture();
  const transport=vi.fn(()=>{throw new Error('History must not call external services');}); vi.stubGlobal('fetch',transport);
  const agent=vi.fn(),runtime=vi.fn(),judge=vi.fn();
  const app=await createEvaluationService({dataDirectory:f.root,rootDirectory:path.resolve('.'),accessToken:'history-test-token',publicDemo:false,bundlePorts:{agent,runtime,judge}});
  const headers={authorization:'Bearer history-test-token'};
  try {
    const prefix='/api/history/bundles/'+f.id;
    for(const url of ['/api/history/tasks',prefix,prefix+'/archive','/api/history/environments'])expect((await app.inject({url})).statusCode).toBe(401);
    expect((await app.inject({url:prefix,headers})).json().record.attempts[0].status).toBe('RUNNING');
    expect((await app.inject({url:'/api/catalog',headers})).statusCode).toBe(200);
    expect((await app.inject({url:'/api/history/environments',headers})).json()).toHaveLength(1);
    for(const action of ['analysis','generate','repair','acceptance','cancel','runtime-check','runtime-build-requests','runtime-deliveries']){
      const r=await app.inject({method:'POST',url:`/api/migration-tasks/${f.id}/${action}`,headers,payload:{}});
      expect(r.statusCode,r.body).toBe(409); expect(r.json().code).toBe('HISTORY_READ_ONLY'); expect(r.json().historyUrl).toBe(prefix);
    }
    for(const url of [`/api/migration-tasks/${f.id}/configuration`,`/api/migration-tasks/${f.id}/suite`])expect((await app.inject({method:'PUT',url,headers,payload:{}})).statusCode).toBe(409);
    for(const method of ['POST','PUT','PATCH','DELETE'] as const)expect((await app.inject({method,url:prefix,headers,payload:{}})).json().code).toBe('HISTORY_READ_ONLY');
    for(const [method,suffix] of [['POST','/preflight'],['PUT',''],['DELETE',''],['PATCH','/archive']] as const){
      const r=await app.inject({method,url:'/api/environments/env-old'+suffix,headers,payload:{}});
      expect(r.statusCode,r.body).toBe(409);expect(r.json().message).toContain('旧协议');
    }
    expect(transport).not.toHaveBeenCalled();expect(agent).not.toHaveBeenCalled();expect(runtime).not.toHaveBeenCalled();expect(judge).not.toHaveBeenCalled();
    expect(await Promise.all(f.files.map(file=>readFile(file)))).toEqual(f.before);
    expect(await readdir(path.join(f.root,'migration-bundles','tasks'))).toEqual([f.id+'.json']);
  }finally{await app.close();}
});
