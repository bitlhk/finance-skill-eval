import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MigrationTaskService } from '../../migration/tasks/application/task-service.js';
import type { MigrationStore } from '../../migration/migration-store.js';
export function registerMigrationTaskRoutes(
  app: FastifyInstance,
  bundles: MigrationTaskService,
  privateWorkspaceEnabled: boolean,
  legacy?: MigrationStore,
) {
  app.addHook('preValidation', async (request, reply) => {
    if (!privateWorkspaceEnabled && ['/api/migration-tasks', '/api/migration-bundles'].some(prefix => request.url.startsWith(prefix)))
      return reply.code(403).send({ message: '整组迁移仅限私有工作区。' });
  });
  for (const prefix of ['/api/migration-tasks', '/api/migration-bundles']) {
    app.get(prefix, () => bundles.list());
    app.post(prefix, (request) => bundles.create(request.body, request.id));
    app.post(prefix + '/upload', (request) => {
      if (!Buffer.isBuffer(request.body))
        throw Object.assign(new Error('请上传完整工程 ZIP'), { statusCode: 400 });
      return bundles.upload(request.query, request.body, request.id);
    });
    app.get<{ Params: { id: string; }; }>(prefix + '/:id', (request) =>
      bundles.get(request.params.id),
    );
    app.put<{ Params: { id: string; }; }>(prefix + '/:id/configuration', (request) =>
      bundles.configure(request.params.id, request.body),
    );
    app.put<{ Params: { id: string; }; }>(prefix + '/:id/suite', (request) =>
      bundles.saveSuite(request.params.id, request.body),
    );
    app.post<{ Params: { id: string; }; }>(prefix + '/:id/runtime-check', (request) =>
      bundles.checkRuntime(request.params.id),
    );
    for (const [route, kind] of [
      ['analysis', 'ANALYZE'],
      ['generate', 'GENERATE'],
      ['repair', 'REPAIR'],
      ['acceptance', 'ACCEPT'],
    ] as const) {
      app.post<{ Params: { id: string; }; }>(prefix + '/:id/' + route, async (request, reply) =>
        reply.code(202).send(await bundles.start(request.params.id, kind, request.body, request.id)),
      );
    }
    app.post<{ Params: { id: string; }; }>(prefix + '/:id/cancel', (request) =>
      bundles.cancel(request.params.id),
    );
    app.get<{ Params: { id: string; }; }>(prefix + '/:id/file', (request) => {
      const query = z
        .strictObject({ candidateId: z.string().optional(), path: z.string() })
        .parse(request.query);
      return bundles.files(request.params.id, query.candidateId ?? null, query.path);
    });
    app.get<{ Params: { id: string; }; }>(prefix + '/:id/export', async (request, reply) => {
      const query = z
        .strictObject({ verified: z.enum(['true', 'false']).default('false') })
        .parse(request.query);
      return reply
        .type('application/zip')
        .header('content-disposition', 'attachment; filename="migration-bundle.zip"')
        .send(await bundles.export(request.params.id, query.verified === 'true'));
    });
  }
  if (legacy) app.post<{ Params: { id: string; }; }>('/api/migration-tasks/from-legacy/:id', async request => {
    const body = z.strictObject({ name: z.string().min(1).max(120), goal: z.string().min(1).max(8000), target: z.string().min(1).max(2000), selection: z.enum(['source', 'candidate']).default('source') }).parse(request.body);
    const project = await legacy.get(request.params.id);
    const asset = body.selection === 'candidate' ? project.candidate : project.source;
    if (!asset) throw Object.assign(new Error('旧任务没有可导入的候选'), { statusCode: 409 });
    return bundles.importLegacy({ name: body.name, goal: body.goal, target: body.target, sourceAssetIds: [asset.assetId] },
      { kind: 'legacy-project', projectId: project.id, assetId: asset.assetId, selection: body.selection }, request.id);
  });
}
