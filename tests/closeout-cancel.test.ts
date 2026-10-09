import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {it,expect,vi} from 'vitest';
import {EvaluationJobStore} from '../src/service/job-store.js';
import {EvaluationRunManager} from '../src/service/run-manager.js';
import {loadEvalPack} from '../src/eval-pack.js';

it('persists cancellation receipts without reviving the parent, refreshes and retries unchanged configuration',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'closeout-cancel-'));
  const jobs=new EvaluationJobStore(dir);await jobs.initialize();
  const pack=await loadEvalPack(path.resolve('packs/finance/investment-research/eval.yaml'));
  pack.cases=pack.cases.slice(0,1);
  const manager=new EvaluationRunManager({jobs,maxConcurrentRuns:1,catalog:{get:()=>structuredClone(pack)} as never,
    environments:{} as never,preparations:{} as never,skills:{} as never});
  let started!:()=>void;const running=new Promise<void>(resolve=>started=resolve);
  const runtime={adapterId:'isolated-cancel',async execute(request:any){started();await new Promise((_,reject)=>{
    request.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});
    if(request.signal.aborted)reject(Error('cancelled'));
  });throw Error('unreachable');},async cleanup(){},finalizationEvidence(){return {status:'RELEASED',instanceId:'this-instance',buildId:'this-build'};}};
  vi.spyOn(manager as any,'runtimeFor').mockResolvedValue(runtime);
  try{
    const job=await manager.create({packId:pack.packId,runtime:{type:'replay'}});
    await running;await manager.cancel(job.jobId);
    await vi.waitFor(()=>expect(jobs.get(job.jobId)?.finalization).toBeDefined(),{timeout:10000});
    const saved=jobs.get(job.jobId)!;
    expect(saved.status).toBe('cancelled');expect(saved.cancellation?.workerSettledAt).toBeTruthy();
    expect(saved.finalization).toMatchObject({jobId:job.jobId,resources:{instanceId:'this-instance',buildId:'this-build'}});
    const file=path.join(dir,'runs',job.jobId+'.json');const before=await readFile(file,'utf8');
    const reopened=new EvaluationJobStore(dir);await reopened.initialize();
    expect(reopened.get(job.jobId)?.finalization).toEqual(saved.finalization);
    vi.spyOn(manager as any,'pump').mockResolvedValue(undefined);
    const retried=await manager.retry(job.jobId);
    expect(retried.configuration).toEqual(saved.configuration);expect(retried.jobId).not.toBe(job.jobId);
    expect(retried.finalization).toBeUndefined();expect(await readFile(file,'utf8')).toBe(before);
    await manager.cancel(retried.jobId);
  }finally{await manager.close();await rm(dir,{recursive:true,force:true});vi.restoreAllMocks();}
},20000);
