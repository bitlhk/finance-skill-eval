import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {consolidateWorkspace} from '../scripts/consolidate-workspace.mjs';
import {createAcceptanceWorkspace} from '../scripts/lib/acceptance-workspace.mjs';

const roots:string[]=[];
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'workspace-consolidation-test-'));roots.push(root);
  const a=path.join(root,'a'),b=path.join(root,'b');await mkdir(a);await mkdir(b);
  return {a,b,target:path.join(root,'target'),archive:path.join(root,'archive'),sources:[a,b]};
}
async function put(root:string,file:string,value:unknown){
  const destination=path.join(root,file);await mkdir(path.dirname(destination),{recursive:true});
  await writeFile(destination,typeof value==='string'?value:JSON.stringify(value));
}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

it('places manual evidence under the project and gives repeated runs independent directories',async()=>{
  const plan=await fixture(),root=path.dirname(plan.a);
  const first=await createAcceptanceWorkspace('real-ui-',root),second=await createAcceptanceWorkspace('real-ui-',root);
  expect(path.dirname(first)).toBe(path.join(root,'.migration-workspace','acceptance'));
  expect(first).not.toBe(second);
  await expect(createAcceptanceWorkspace('../escape-',root)).rejects.toThrow('Invalid');
});

it('keeps complete selected projects and matching configurations, with both originals archived',async()=>{
  const plan=await fixture(),id='migration-aaaaaaaa';
  for(const [root,runs] of [[plan.a,['run-a']],[plan.b,['run-a','run-b']]] as const){
    await put(root,`migrations/${id}.json`,{schemaVersion:'finance.skill-migration.v2',id,runs:runs.map(jobId=>({jobId}))});
    await put(root,`migration-runtime-config/${id}.json`,{selected:root});
    for(const jobId of runs)await put(root,`runs/${jobId}.json`,{jobId});
  }
  await consolidateWorkspace({...plan,projectSources:{[id]:plan.a}});
  const project=JSON.parse(await readFile(path.join(plan.target,`migrations/${id}.json`),'utf8'));
  expect(project.runs).toEqual([{jobId:'run-a'}]);
  expect(JSON.parse(await readFile(path.join(plan.target,`migration-runtime-config/${id}.json`),'utf8')).selected).toBe(plan.a);
  expect(JSON.parse(await readFile(path.join(plan.archive,`source-001/migrations/${id}.json`),'utf8')).runs).toHaveLength(2);
  expect(JSON.parse(await readFile(path.join(plan.b,`migrations/${id}.json`),'utf8')).runs).toHaveLength(2);
});
it('refuses conflicting immutable asset bytes before writing output',async()=>{
  const plan=await fixture();
  await put(plan.a,'skills/assets/asset-a/SKILL.md','original');
  await put(plan.b,'skills/assets/asset-a/SKILL.md','different');
  await expect(consolidateWorkspace(plan)).rejects.toThrow('Conflicting immutable asset');
  await expect(access(plan.target)).rejects.toThrow();
});
it('rejects missing referenced runs instead of presenting an incomplete recovered project',async()=>{
  const plan=await fixture();
  await put(plan.a,'migrations/migration-aaaaaaaa.json',{schemaVersion:'finance.skill-migration.v2',id:'migration-aaaaaaaa',runs:[{jobId:'run-missing'}]});
  await expect(consolidateWorkspace(plan)).rejects.toThrow('Missing run');
  await expect(access(plan.target)).rejects.toThrow();
});
it('refuses existing destinations and overlapping source paths',async()=>{
  const plan=await fixture();await mkdir(plan.target);
  await expect(consolidateWorkspace(plan)).rejects.toThrow('already exists');
  await expect(consolidateWorkspace({...plan,target:path.join(plan.a,'nested')})).rejects.toThrow('Overlapping');
});

it('selects a unified task and its snapshots from one source, including explicit selection',async()=>{
  const plan=await fixture(),id='bundle-aaaaaaaa';
  for(const [root,digest] of [[plan.a,'digest-a'],[plan.b,'digest-b']] as const){
    await put(root,`migration-tasks/tasks/${id}.json`,{schemaVersion:'finance.skill-migration.task.v1',id,source:{digest},candidates:[]});
    await put(root,`migration-tasks/snapshots/${id}/source.json`,{digest});
    await put(root,`migration-activity/${id}.json`,{source:root});
  }
  const result=await consolidateWorkspace({...plan,projectSources:{[id]:plan.a}});
  expect(result.projects).toBe(1);
  expect(JSON.parse(await readFile(path.join(plan.target,`migration-tasks/snapshots/${id}/source.json`),'utf8')).digest).toBe('digest-a');
  expect(JSON.parse(await readFile(path.join(plan.target,`migration-activity/${id}.json`),'utf8')).source).toBe(plan.a);
});
it('does not mix an older snapshot into the selected newer task',async()=>{
  const plan=await fixture(),id='bundle-aaaaaaaa';
  for(const root of [plan.a,plan.b])await put(root,`migration-tasks/tasks/${id}.json`,{schemaVersion:'finance.skill-migration.task.v1',id,source:{digest:'same'},candidates:[]});
  await put(plan.a,`migration-tasks/snapshots/${id}/source.json`,{digest:'same'});
  await expect(consolidateWorkspace(plan)).rejects.toThrow('Missing task snapshot');
  await expect(access(plan.target)).rejects.toThrow();
});
it('rejects a task whose saved snapshot differs from its bound digest',async()=>{
  const plan=await fixture(),id='bundle-aaaaaaaa';
  await put(plan.a,`migration-tasks/tasks/${id}.json`,{schemaVersion:'finance.skill-migration.task.v1',id,source:{digest:'expected'},candidates:[]});
  await put(plan.a,`migration-tasks/snapshots/${id}/source.json`,{digest:'different'});
  await expect(consolidateWorkspace(plan)).rejects.toThrow('Task snapshot digest mismatch');
});
