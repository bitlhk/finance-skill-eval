import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MigrationTaskService } from '../src/migration/tasks/application/task-service.js';
import { FileMigrationTaskRepository } from '../src/migration/tasks/infrastructure/task-repository.js';
import { bundleZip } from '../src/migration/tasks/domain/task-model.js';
import type { BundleAgent } from '../src/migration/tasks/application/task-ports.js';
import { MigrationActivityStore } from '../src/migration/infrastructure/migration-activity.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'migration-registration-'));
  const repository = new FileMigrationTaskRepository(root);
  const agent = vi.fn<BundleAgent>(async () => ({ status: 'PRODUCED', analysis: { summary: 'Analyzed', changes: [], missing: [] } }));
  const runtime = vi.fn(async () => { throw new Error('Unexpected Runtime startup'); });
  const service = new MigrationTaskService(repository, { get: async () => null, readArchive: async () => ({}) },
    agent, runtime, async () => ({ passed: true, reason: 'unused' }), undefined, undefined, new MigrationActivityStore(root));
  cleanups.push(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const create = () => service.upload({ name: 'Race', goal: 'Analyze', target: 'openjiuwen' },
    bundleZip({ 'SKILL.md': Buffer.from('---\nname: race\ndescription: Registration race\n---\nRead inputs.').toString('base64') }));
  return { repository, service, agent, runtime, create, task: await create() };
}

it.each(['cancel', 'close'] as const)('%s owns an operation while its RUNNING write is settling', async action => {
  const f = await fixture(), persisted = gate(), release = gate();
  const update = f.repository.update.bind(f.repository);
  vi.spyOn(f.repository, 'update').mockImplementationOnce(async (id, change) => {
    const task = await update(id, change); // Real atomic file write, not an in-memory repository.
    persisted.release();
    await release.promise;
    return task;
  });
  const start = f.service.start(f.task.id, 'ANALYZE', { key: 'pending', baseCandidateId: null });
  await persisted.promise;
  expect((await f.repository.get(f.task.id)).attempts[0]?.status).toBe('RUNNING');
  let returned = false;
  const stop = (action === 'cancel' ? f.service.cancel(f.task.id) : f.service.close()).then(() => { returned = true; });
  try {
    // Allow the real file read in cancel to complete while registration stays gated.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(returned).toBe(false);
  } finally { release.release(); await start; await stop; }
  expect(f.agent).not.toHaveBeenCalled();
  expect(f.runtime).not.toHaveBeenCalled();
  expect((await f.service.get(f.task.id)).attempts[0]?.status).toBe('CANCELLED');
  expect((await f.service.get(f.task.id)).candidates).toEqual([]);
});

it.each(['cancel', 'close'] as const)('%s waits for registration queued before the repository callback', async action => {
  const f = await fixture(), entered = gate(), release = gate();
  const update = f.repository.update.bind(f.repository);
  vi.spyOn(f.repository, 'update').mockImplementationOnce(async (id, change) => {
    entered.release();
    await release.promise;
    return update(id, change);
  });
  const start = f.service.start(f.task.id, 'ANALYZE', { key: 'queued', baseCandidateId: null });
  const rejected = expect(start).rejects.toThrow();
  await entered.promise;
  let returned = false;
  const stop = (action === 'cancel' ? f.service.cancel(f.task.id) : f.service.close()).then(() => { returned = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(returned).toBe(false);
    if (action === 'close') {
      await expect(f.service.start(f.task.id, 'ANALYZE', { key: 'after-close', baseCandidateId: null })).rejects.toMatchObject({ statusCode: 503 });
    }
  } finally { release.release(); await rejected; await stop; }
  expect((await f.repository.get(f.task.id)).attempts).toEqual([]);
  expect(f.agent).not.toHaveBeenCalled();
});

it('an idempotent duplicate cannot remove the registering owner from cancellation', async () => {
  const f = await fixture(), persisted = gate(), release = gate();
  const update = f.repository.update.bind(f.repository);
  vi.spyOn(f.repository, 'update').mockImplementationOnce(async (id, change) => {
    const task = await update(id, change);
    persisted.release();
    await release.promise;
    return task;
  });
  const input = { key: 'same-key', baseCandidateId: null };
  const start = f.service.start(f.task.id, 'ANALYZE', input);
  await persisted.promise;
  try {
    expect((await f.service.start(f.task.id, 'ANALYZE', input)).attempts).toHaveLength(1);
    const cancelled = f.service.cancel(f.task.id);
    await new Promise(resolve => setTimeout(resolve, 50));
    release.release();
    await start;
    expect((await cancelled).attempts[0]?.status).toBe('CANCELLED');
    expect(f.agent).not.toHaveBeenCalled();
  } finally { release.release(); await start; }
});

it('failed registration releases capacity and close waits for both remaining operations', async () => {
  const f = await fixture();
  for (let index = 0; index < 2; index++) {
    const task = await f.create();
    // The real repository invokes reservation, but the atomic write cannot occur.
    vi.spyOn(f.repository, 'update').mockImplementationOnce(async (id, change) => {
      await change(await f.repository.get(id));
      throw new Error('controlled persistence failure');
    });
    await expect(f.service.start(task.id, 'ANALYZE', { key: 'failure', baseCandidateId: null })).rejects.toThrow('persistence failure');
  }
  f.agent.mockImplementation(async ({ signal }) => new Promise((_, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const tasks = [await f.create(), await f.create(), await f.create()];
  await f.service.start(tasks[0]!.id, 'ANALYZE', { key: 'first', baseCandidateId: null });
  await f.service.start(tasks[1]!.id, 'ANALYZE', { key: 'second', baseCandidateId: null });
  await vi.waitFor(() => expect(f.agent).toHaveBeenCalledTimes(2));
  await expect(f.service.start(tasks[2]!.id, 'ANALYZE', { key: 'third', baseCandidateId: null })).rejects.toMatchObject({ statusCode: 429 });
  await Promise.all([f.service.close(), f.service.close()]);
  for (const task of tasks.slice(0, 2)) expect((await f.repository.get(task.id)).attempts[0]?.status).toBe('CANCELLED');
});
