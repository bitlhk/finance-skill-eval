import {it,expect} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import Fastify from 'fastify';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MigrationActivityStore,migrationActivityContext} from '../src/migration/infrastructure/migration-activity.js';

it('isolates concurrent projects, merges response snapshots, persists terminal state and cancels',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'activity-'));const store=new MigrationActivityStore(root);
 try{
  await Promise.all(['a','b'].map(id=>store.run(id,async()=>{
   const context=migrationActivityContext.getStore()!;
   context.emit('model_start','等待模型');context.emit('text_snapshot','响应',id);context.emit('text_snapshot','响应',id+' final');
   expect((await store.get(id))!.events.filter(e=>e.kind==='text_snapshot')).toHaveLength(1);
  })));
  const restored=await new MigrationActivityStore(root).get('a');expect(restored?.status).toBe('COMPLETED');expect(restored?.events.find(e=>e.text)?.text).toBe('a final');
  const running=store.run('c',()=>new Promise<void>(resolve=>{migrationActivityContext.getStore()!.signal.addEventListener('abort',()=>resolve());}));
  await expect(store.run('c',async()=>{})).rejects.toMatchObject({statusCode:409});store.cancel('c');await expect(running).rejects.toThrow('取消');expect((await store.get('c'))?.status).toBe('CANCELLED');
 }finally{await rm(root,{recursive:true,force:true});}
});

it('bounds activity history and restores interrupted and failed tasks',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'activity-'));
 try{
  const store=new MigrationActivityStore(root);
  await expect(store.run('failed',async()=>{
   for(let i=0;i<250;i++)migrationActivityContext.getStore()!.emit('tool_start',`tool ${i}`);
   throw new Error('private error');
  })).rejects.toThrow('private error');
  const state=(await store.get('failed'))!;
  expect(state.events).toHaveLength(200);expect(state.status).toBe('FAILED');
  expect(JSON.stringify(state)).not.toContain('private error');
  state.status='RUNNING';await writeFile(path.join(root,'migration-activity','interrupted.json'),JSON.stringify(state));
  expect((await new MigrationActivityStore(root).get('interrupted'))?.status).toBe('INTERRUPTED');
 }finally{await rm(root,{recursive:true,force:true});}
});
