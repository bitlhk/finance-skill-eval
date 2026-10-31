import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HistoryStore } from '../../service/history-store.js';
import type { HistorySummary } from '../../shared/contracts/history.js';

export function registerHistoryRoutes(app: FastifyInstance, history: HistoryStore, privateWorkspaceEnabled: boolean) {
  const blocked = (record: HistorySummary) => ({ code: 'HISTORY_READ_ONLY', message: record.reason,
    nextStep: record.nextStep, historyUrl: `/api/history/${record.origin}/${record.id}` });
  app.addHook('preValidation', async (request, reply) => {
    const route = request.url.split('?')[0]!;
    if (route.startsWith('/api/history/') && !privateWorkspaceEnabled) return reply.code(403).send({ message: '历史记录仅限私有工作区查看。' });
    const task = route.match(/^\/api\/migration-tasks\/([a-z0-9-]+)(?:\/|$)/);
    const environment = route.match(/^\/api\/environments\/([a-z0-9-]+)(?:\/|$)/);
    const record = task ? await history.blockedTask(task[1]!) : environment ? await history.blockedEnvironment(environment[1]!) : null;
    if (record) return reply.code(409).send(blocked(record));
  });
  app.get('/api/history/tasks', () => history.list('tasks'));
  app.get('/api/history/environments', () => history.list('environments'));
  type Params = { origin: string; id: string };
  app.get<{ Params: Params }>('/api/history/:origin/:id', request => history.get(request.params.origin, request.params.id));
  app.get<{ Params: Params }>('/api/history/:origin/:id/snapshot', request => {
    const query = z.strictObject({ revision: z.string() }).parse(request.query);
    return history.snapshot(request.params.origin, request.params.id, query.revision);
  });
  app.get<{ Params: Params }>('/api/history/:origin/:id/file', request => {
    const query = z.strictObject({ revision: z.string(), path: z.string().max(1000) }).parse(request.query);
    return history.file(request.params.origin, request.params.id, query.revision, query.path);
  });
  app.get<{ Params: Params }>('/api/history/:origin/:id/archive', async (request, reply) => reply.type('application/zip')
    .header('content-disposition', 'attachment; filename="historical-record.zip"')
    .send(await history.archive(request.params.origin, request.params.id)));
  app.route({ method: ['POST', 'PUT', 'PATCH', 'DELETE'], url: '/api/history/*', handler: (_request, reply) =>
    reply.code(409).send({ code: 'HISTORY_READ_ONLY', message: '历史记录仅供查阅，不能修改、删除或继续执行；请使用原始 Skill 新建任务。' }) });
}
