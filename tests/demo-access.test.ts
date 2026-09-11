import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {it,expect} from 'vitest';
import {DemoAccess} from '../src/service/demo-access.js';

it('persists the public demo budget and binds cancellation to the initiating user', async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'eval-demo-'));
  try {
    const access=new DemoAccess(directory), user=access.identity('studio_123');
    expect(()=>access.identity('spoof')).toThrow();
    for(let i=0;i<3;i++) await access.create(user,()=>0,async()=>({jobId:`job-${i}`}));
    await expect(new DemoAccess(directory).create(user,()=>0,async()=>({jobId:'extra'}))).rejects.toThrow(/额度/);
    await expect(access.assertOwner(user,'job-0')).resolves.toBeUndefined();
    await expect(access.assertOwner(access.identity('studio_456'),'job-0')).rejects.toThrow(/自己/);
  } finally {await rm(directory,{recursive:true,force:true});}
});
it('serializes concurrent admission and does not add jobs to a full queue',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'eval-demo-'));
  try{
    const a=new DemoAccess(directory),u=a.identity('studio_1');
    await expect(a.create(u,()=>3,async()=>({jobId:'no'}))).rejects.toThrow(/任务较多/);
    const results=await Promise.allSettled(Array.from({length:4},(_,i)=>a.create(u,()=>0,async()=>({jobId:String(i)}))));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(3);
  }finally{await rm(directory,{recursive:true,force:true});}
});
