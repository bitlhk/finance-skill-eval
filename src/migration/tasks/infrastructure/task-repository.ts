import path from 'node:path';
import { writeJsonAtomic, readJson, listJsonFiles } from '../../../service/file-store.js';
import { KeyedQueue } from '../../../shared/keyed-queue.js';
import { bundleIdSchema, bundleError, type BundleTask, type BundleSnapshot } from '../domain/task-model.js';
import type { MigrationTaskRepository } from '../application/task-ports.js';

/** A single API writer owns this directory; candidates are immutable snapshots. */
export class FileMigrationTaskRepository implements MigrationTaskRepository {
  private queue = new KeyedQueue();
  constructor(private root: string) { }
  private taskFile(id: string) {
    bundleIdSchema.parse(id);
    return path.join(this.root, 'migration-tasks', 'tasks', id + '.json');
  }
  private snapshotFile(id: string, revision: string) {
    bundleIdSchema.parse(id);
    if (!/^(source|candidate-[a-f0-9-]+)$/.test(revision)) bundleError('版本标识无效', 400);
    return path.join(this.root, 'migration-tasks', 'snapshots', id, revision + '.json');
  }
  async list() {
    const files = await listJsonFiles(path.join(this.root, 'migration-tasks', 'tasks'));
    return (await Promise.all(files.map((file) => readJson<BundleTask>(file)))).filter(task=>task.schemaVersion==='finance.skill-migration.task.v1').sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
  async get(id: string): Promise<BundleTask> {
    try {
      const task=await readJson<BundleTask>(this.taskFile(id));
      if(task.schemaVersion!=='finance.skill-migration.task.v1')bundleError('该记录不属于当前任务协议',409);
      return task;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') bundleError('迁移任务不存在', 404);
      throw e;
    }
  }
  async readSnapshot(id: string, candidateId: string | null) {
    await this.get(id);
    return readJson<BundleSnapshot>(this.snapshotFile(id, candidateId ?? 'source'));
  }
  update(id: string, change: (task: BundleTask) => void | Promise<void>) {
    return this.queue.run(id, async () => {
      const task = await this.get(id);
      await change(task);
      await writeJsonAtomic(this.taskFile(id), task);
      return task;
    });
  }
  async save(task: BundleTask) { await writeJsonAtomic(this.taskFile(task.id), task); }
  async saveSnapshot(id: string, revision: string, snapshot: BundleSnapshot) {
    await writeJsonAtomic(this.snapshotFile(id, revision), snapshot);
  }
}
