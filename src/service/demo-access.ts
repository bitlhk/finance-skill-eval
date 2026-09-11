import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './file-store.js';

type Admission = { user: string; at: string; jobId: string | null };
const fail = (message: string, statusCode = 403): never => { throw Object.assign(new Error(message), { statusCode }); };

/** Small, persisted admission budget for the shared synthetic public demo. */
export class DemoAccess {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  private get file() { return path.join(this.directory, 'demo-admissions.json'); }
  private async records(): Promise<Admission[]> {
    return readJson<Admission[]>(this.file).catch(error => { if(error.code === 'ENOENT') return []; throw error; });
  }
  identity(header: unknown): string {
    if (typeof header !== 'string' || !/^studio_[a-zA-Z0-9_-]{1,80}$/.test(header)) return fail('请先登录灵感平台。',401);
    return createHash('sha256').update(header).digest('hex');
  }
  async create<T extends { jobId: string }>(user: string, pending: () => number, start: () => Promise<T>): Promise<T> {
    const task = this.chain.then(async () => {
      const now = new Date(), day = now.toISOString().slice(0,10);
      const records = await this.records();
      const today = records.filter(r=>r.at.startsWith(day));
      if(today.length >= 12 || today.filter(r=>r.user===user).length>=3) return fail('公开演示今日额度已用完，请明日再试。',429);
      if(pending()>=3) return fail('演示任务较多，请等待当前批次完成后再试。',429);
      const admission: Admission={user,at:now.toISOString(),jobId:null};
      records.push(admission);
      await writeJsonAtomic(this.file, records);
      const job=await start();
      admission.jobId=job.jobId;
      await writeJsonAtomic(this.file,records);
      return job;
    });
    this.chain=task.catch(()=>{});
    return task;
  }
  async assertOwner(user: string, jobId: string): Promise<void> {
    if(!(await this.records()).some(r=>r.user===user&&r.jobId===jobId)) fail('只能取消自己发起的演示任务。');
  }
}
