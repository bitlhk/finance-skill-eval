import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MigrationTaskService } from '../src/migration/tasks/application/task-service.js';
import { FileMigrationTaskRepository } from '../src/migration/tasks/infrastructure/task-repository.js';
import { bundleZip, type BundleTask } from '../src/migration/tasks/domain/task-model.js';
import type { BundleRuntimeFactory } from '../src/migration/tasks/application/task-ports.js';
import { migrationProgress } from '../web/src/features/migration/progress.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
const files = {'SKILL.md':Buffer.from('---\nname: meetingroom\ndescription: 查询会议室空闲时间\n---\n保留时区与预约冲突规则。').toString('base64')};
const configuration = {environmentId:'env-fixture',modelId:'model-fixture',timeoutMs:10000,harnessTools:[]};
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(),'migration-entry-')); roots.push(root);
  const repository = new FileMigrationTaskRepository(root);
  const prepare = vi.fn(async () => {}), cleanup = vi.fn(async () => {});
  const runtime = vi.fn<BundleRuntimeFactory>(async () => ({runtime:{adapterId:'fixture',prepare,cleanup,execute:async()=>{throw new Error('Unexpected execution');}},model:{providerId:'fixture',modelId:'fixture',parameters:{}},environmentSnapshot:{id:'fixture'}}));
  const agent = vi.fn(async () => {throw new Error('Creating a task must not call a model');});
  const service = new MigrationTaskService(repository,{get:async()=>({}),readArchive:async()=>({'SKILL.md':Buffer.from(files['SKILL.md'],'base64')})},agent,runtime,async()=>({passed:true,reason:'fixture'}));
  const task = await service.upload({},bundleZip(files));
  const candidate = {...task.source,id:'candidate-aabb',parentId:null,createdAt:task.createdAt,summary:'candidate',services:[],diff:[],checks:[]};
  async function generated() {
    const source=await repository.readSnapshot(task.id,null);await repository.saveSnapshot(task.id,candidate.id,source);
    await repository.update(task.id,value=>{value.analysis={summary:'分析完成',changes:[],missing:[]};value.candidates=[candidate];value.currentCandidateId=candidate.id;});
    await service.configure(task.id,configuration);
  }
  return {root,repository,service,task,candidate,generated,agent,runtime,prepare,cleanup};
}

it('creates ZIP and selected-asset tasks without form text and derives descriptions from the original Skill',async()=>{
  const f=await fixture();
  expect(f.task.name).toBe('meetingroom 迁移');expect(f.task.goal).toContain('查询会议室空闲时间');expect(f.task.goal).toContain('保留原 Skill');
  expect(f.task.target).toContain('框架无关');
  expect(f.task.target).toContain('改造、部署与维护成本');
  expect((await f.service.readSnapshot(f.task.id,null)).files).toEqual(files);
  const selected=await f.service.create({sourceAssetIds:['asset-1'],configuration});
  expect(selected.name).toBe('meetingroom 迁移');expect(selected.configuration).toEqual(configuration);
  const uploaded=await f.service.upload({configuration:JSON.stringify(configuration)},bundleZip(files));
  expect(uploaded.configuration).toEqual(configuration);
  const custom=await f.service.upload({name:'自定义',goal:'明确要求',target:'已指定平台'},bundleZip(files));
  expect(custom).toMatchObject({name:'自定义',goal:'明确要求',target:'已指定平台'});
  await expect(f.service.upload({configuration:'not-json'},bundleZip(files))).rejects.toMatchObject({statusCode:400});
  const projectFiles = {
    'my-project/features/rooms/SKILL.md': files['SKILL.md'],
    'my-project/features/images/SKILL.md': Buffer.from('---\nname: analyze_image\ndescription: 分析图像\n---\nUse ../../shared/config.json.').toString('base64'),
    'my-project/shared/config.json': Buffer.from('{"timezone":"Asia/Shanghai"}').toString('base64'),
    'my-project/src/tool.py': Buffer.from('print("source stays intact")').toString('base64'),
    'my-project/requirements.txt': Buffer.from('Pillow==11.0.0').toString('base64'),
    'my-project/resources/sample.bin': Buffer.from([0,255,128,42]).toString('base64'),
  };
  const project = await f.service.upload({}, bundleZip(projectFiles));
  expect(project.source.members).toHaveLength(2);
  expect((await f.service.readSnapshot(project.id,null)).files).toEqual(projectFiles);
  expect(f.agent).not.toHaveBeenCalled();expect(f.runtime).not.toHaveBeenCalled();
});

it('shows the entire initial workflow without treating later pages or saved configuration as completed work',async()=>{
  expect(migrationProgress(null)).toHaveLength(7);
  expect(migrationProgress(null).filter(stage=>stage.available)).toHaveLength(1);
  const f=await fixture();
  await f.service.configure(f.task.id,configuration);
  const progress=migrationProgress(await f.service.get(f.task.id));
  expect(progress.map(stage=>stage.status)).toEqual(['completed','pending','pending','pending','pending','pending','pending']);
  expect(progress[2]?.available).toBe(false);
});

it('persists startup results and invalidates them when the candidate, configuration or Builder selection changes',async()=>{
  const f=await fixture();await f.generated();
  await f.service.checkRuntime(f.task.id);
  expect(f.cleanup).toHaveBeenCalledTimes(1);
  let task=await f.service.get(f.task.id);
  expect(task.startupCheckCurrent).toBe(true);expect(migrationProgress(task)[4]?.status).toBe('completed');
  expect((await new FileMigrationTaskRepository(f.root).get(task.id)).startupCheck?.status).toBe('PASSED');
  await f.service.configure(task.id,{...configuration,modelId:'changed'});
  task=await f.service.get(task.id);expect(task.startupCheckCurrent).toBe(false);expect(migrationProgress(task)[4]?.label).toBe('需重新检查');
  await f.service.configure(task.id,configuration);
  await f.repository.update(task.id,value=>{value.currentCandidateId='candidate-ccdd';});
  expect((await f.service.get(task.id)).startupCheckCurrent).toBe(false);
  await f.repository.update(task.id,value=>{value.currentCandidateId=f.candidate.id;value.runtimeSelectionRevision='new-selection';});
  expect((await f.service.get(task.id)).startupCheckCurrent).toBe(false);
});

it('does not leave a passed badge after a failed retry, and marks abandoned startup checks interrupted on restart',async()=>{
  const f=await fixture();await f.generated();await f.service.checkRuntime(f.task.id);
  f.prepare.mockRejectedValueOnce(new Error('Startup failed'));
  await expect(f.service.checkRuntime(f.task.id)).rejects.toThrow('Startup failed');
  expect(f.cleanup).toHaveBeenCalledTimes(2);
  expect(migrationProgress(await f.service.get(f.task.id))[4]).toMatchObject({status:'attention',label:'未通过'});
  await f.repository.update(f.task.id,task=>{task.startupCheck!.status='RUNNING';});
  await f.service.initialize();
  expect(migrationProgress(await f.service.get(f.task.id))[4]?.label).toBe('已中断');
});

it('ignores obsolete acceptance evidence and requires complete acceptance before showing deliverable readiness',async()=>{
  const f=await fixture();await f.generated();
  const task=await f.service.get(f.task.id);
  task.suite={name:'test',cases:[{id:'one',input:'查空闲时间',criteria:['必须有依据']}]};
  task.runs=[{id:'run-one',candidateId:f.candidate.id,candidateDigest:f.candidate.digest,configuration:task.configuration!,configurationDigest:'',suite:task.suite,suiteDigest:'',phase:'development',status:'FAILED',createdAt:task.createdAt,cases:[]}];
  expect(migrationProgress(task)[5]?.label).toBe('未通过');
  task.configuration={...task.configuration!,modelId:'different'};
  expect(migrationProgress(task)[5]?.label).toBe('待验收');
  task.verifiedRunId='verified-current';
  expect(migrationProgress(task)[5]?.status).toBe('completed');
  expect(migrationProgress(task)[6]).toMatchObject({status:'ready',label:'可下载'});
});

it('keeps the newest startup result when an older request finishes later',async()=>{
  const f=await fixture();await f.generated();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  f.prepare.mockImplementationOnce(async()=>{await gate;throw new Error('Older request failed');});
  const older=f.service.checkRuntime(f.task.id);
  const rejected=expect(older).rejects.toThrow('Older request failed');
  await vi.waitFor(()=>expect(f.prepare).toHaveBeenCalledTimes(1));
  try { await f.service.checkRuntime(f.task.id); }
  finally { release();await rejected; }
  expect((await f.service.get(f.task.id)).startupCheck?.status).toBe('PASSED');
});

it('shows missing information, cancellation and current execution without advancing unrelated stages',async()=>{
  const f=await fixture();const task:BundleTask={...f.task,analysis:{summary:'missing',changes:[],missing:['缺少接口文档']}};
  expect(migrationProgress(task)[1]?.label).toBe('待补充');expect(migrationProgress(task)[2]?.available).toBe(false);
  task.attempts=[{id:'attempt-a',kind:'ANALYZE',key:'key',requestDigest:'digest',baseCandidateId:null,status:'RUNNING',startedAt:task.createdAt,message:'Analyzing'}];
  expect(migrationProgress(task)[1]?.status).toBe('running');
  task.attempts[0]!.status='CANCELLED';expect(migrationProgress(task)[1]?.label).toBe('已取消');
  expect(migrationProgress(task)[5]?.status).toBe('pending');
});


it('never treats a default or saved environment as ready before current-candidate verification',async()=>{
  const f=await fixture();
  const initial=await f.service.upload({configuration},bundleZip(files));
  expect(initial.configurationConfirmed).toBeUndefined();
  expect(migrationProgress(initial)[3]).toMatchObject({status:'pending',available:false});
  await f.generated();
  const chosen=await f.service.get(f.task.id);
  expect(chosen.configurationConfirmed).toBe(true);
  expect(migrationProgress(chosen)[3]).toMatchObject({status:'pending',label:'已选择，待检查'});
  expect(migrationProgress(chosen)[4]?.available).toBe(true);
  await f.service.checkRuntime(f.task.id);
  expect(migrationProgress(await f.service.get(f.task.id))[3]?.status).toBe('pending'); // Startup alone cannot certify missing requirements.
  await f.service.configure(f.task.id,{...configuration,modelId:'different'});
  expect(migrationProgress(await f.service.get(f.task.id))[3]?.status).toBe('pending');
  const previous={...chosen,configurationConfirmed:undefined};
  expect(migrationProgress(previous)[3]?.status).toBe('pending');
  expect(migrationProgress(previous)[4]?.available).toBe(false);
});
