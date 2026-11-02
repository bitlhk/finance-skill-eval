import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { MigrationTaskService } from '../src/migration/tasks/application/task-service.js';
import { FileMigrationTaskRepository } from '../src/migration/tasks/infrastructure/task-repository.js';
import { MigrationActivityStore, migrationActivityContext } from '../src/migration/infrastructure/migration-activity.js';
import { registerMigrationTaskRoutes } from '../src/interfaces/http/migration-task-routes.js';
import { bundleZip } from '../src/migration/tasks/domain/task-model.js';
import type { BundleAgent } from '../src/migration/tasks/application/task-ports.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(agent: BundleAgent, members = 1) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-activity-'));
  const activity = new MigrationActivityStore(root);
  const service = new MigrationTaskService(new FileMigrationTaskRepository(root), { get: async () => null, readArchive: async () => ({}) },
    agent, async () => { throw new Error('Unexpected Runtime'); }, async () => ({ passed: false, reason: 'unused' }), undefined, undefined, activity);
  const app = Fastify(); registerMigrationTaskRoutes(app, service, true);
  const task = await service.upload({ name: 'Activity', goal: 'Analyze', target: 'openjiuwen' }, bundleZip(Object.fromEntries(
    Array.from({ length: members }, (_, i) => [`skills/s${i}/SKILL.md`, Buffer.from(`---\nname: s${i}\ndescription: Test\n---\nRead input.`).toString('base64')]))));
  cleanup.push(async () => { await service.close(); await app.close(); await rm(root, { recursive: true, force: true }); });
  return { root, activity, service, app, task };
}

it.each([1, 3])('persists activity for %i Skills on the unified API and keeps old routes unavailable', async members => {
  const f = await fixture(async () => {
    migrationActivityContext.getStore()!.emit('text_snapshot', '接收模型响应', 'Analysis output');
    return { status: 'PRODUCED', analysis: { summary: 'Done', changes: [], missing: [] } };
  }, members);
  const response = await f.app.inject({ method: 'POST', url: `/api/migration-tasks/${f.task.id}/analysis`, payload: { key: 'analyze', baseCandidateId: null } });
  expect(response.statusCode).toBe(202);
  await expect.poll(async () => (await f.activity.get(f.task.id))?.status).toBe('COMPLETED');
  const state = (await f.app.inject(`/api/migration-tasks/${f.task.id}/activity`)).json();
  expect(state.taskId).toBe((await f.service.get(f.task.id)).attempts[0].id);
  expect(state.events.some((event: { text?: string }) => event.text === 'Analysis output')).toBe(true);
  await expect.poll(async () => (await new MigrationActivityStore(f.root).get(f.task.id))?.status).toBe('COMPLETED');
  expect((await f.app.inject(`/api/migrations/${f.task.id}/activity`)).statusCode).toBe(404);
});

it('shows a rejected Agent result as failed rather than completed', async () => {
  const f = await fixture(async () => ({ status: 'ABSTAINED', reason: 'Need source' }));
  await f.service.start(f.task.id, 'ANALYZE', { key: 'analyze', baseCandidateId: null });
  await expect.poll(async () => (await f.activity.get(f.task.id))?.status).toBe('FAILED');
  expect((await f.service.get(f.task.id)).attempts[0].status).toBe('FAILED');
});

it.each(['cancel', 'close'] as const)('%s waits for activity persistence and uses the task cancellation signal', async action => {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(async input => {
    expect(migrationActivityContext.getStore()!.signal.aborted).toBe(false);
    entered();
    await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
    return { status: 'ABSTAINED', reason: 'Cancelled' };
  });
  await f.service.start(f.task.id, 'ANALYZE', { key: 'analyze', baseCandidateId: null }); await ready;
  if (action === 'close') await f.service.close();
  else expect((await f.app.inject({ method: 'POST', url: `/api/migration-tasks/${f.task.id}/cancel` })).statusCode).toBe(200);
  expect((await new MigrationActivityStore(f.root).get(f.task.id))?.status).toBe('CANCELLED');
});

it('streams unified activity, closes SSE on shutdown and protects private activity', async () => {
  const f = await fixture(async () => ({ status: 'ABSTAINED', reason: 'unused' }));
  const blocked = Fastify(); registerMigrationTaskRoutes(blocked, f.service, false);
  try { expect((await blocked.inject(`/api/migration-tasks/${f.task.id}/activity/events`)).statusCode).toBe(403); }
  finally { await blocked.close(); }
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  try {
    const response = await fetch(`${address}/api/migration-tasks/${f.task.id}/activity/events`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: null\n\n');
    await f.app.close(); expect((await reader.read()).done).toBe(true);
  } finally { controller.abort(); }
});
