import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BundleMigrationService } from '../../migration/bundle/bundle-service.js';
export function registerBundleMigrationRoutes(
  app: FastifyInstance,
  bundles: BundleMigrationService,
  privateWorkspaceEnabled: boolean,
) {
  app.addHook('preValidation', async (request, reply) => {
    if (!privateWorkspaceEnabled && request.url.startsWith('/api/migration-bundles'))
      return reply.code(403).send({ message: '整组迁移仅限私有工作区。' });
  });
  app.get('/api/migration-bundles', () => bundles.list());
  app.post('/api/migration-bundles', (request) => bundles.create(request.body));
  app.post('/api/migration-bundles/upload', (request) => {
    if (!Buffer.isBuffer(request.body))
      throw Object.assign(new Error('请上传完整工程 ZIP'), { statusCode: 400 });
    return bundles.upload(request.query, request.body);
  });
  app.get<{ Params: { id: string } }>('/api/migration-bundles/:id', (request) =>
    bundles.get(request.params.id),
  );
  app.put<{ Params: { id: string } }>('/api/migration-bundles/:id/configuration', (request) =>
    bundles.configure(request.params.id, request.body),
  );
  app.put<{ Params: { id: string } }>('/api/migration-bundles/:id/suite', (request) =>
    bundles.saveSuite(request.params.id, request.body),
  );
  app.post<{ Params: { id: string } }>('/api/migration-bundles/:id/runtime-check', (request) =>
    bundles.checkRuntime(request.params.id),
  );
  for (const [route, kind] of [
    ['analysis', 'ANALYZE'],
    ['generate', 'GENERATE'],
    ['repair', 'REPAIR'],
    ['acceptance', 'ACCEPT'],
  ] as const) {
    app.post<{ Params: { id: string } }>('/api/migration-bundles/:id/' + route, async (request, reply) =>
      reply.code(202).send(await bundles.start(request.params.id, kind, request.body)),
    );
  }
  app.post<{ Params: { id: string } }>('/api/migration-bundles/:id/cancel', (request) =>
    bundles.cancel(request.params.id),
  );
  app.get<{ Params: { id: string } }>('/api/migration-bundles/:id/file', (request) => {
    const query = z
      .strictObject({ candidateId: z.string().optional(), path: z.string() })
      .parse(request.query);
    return bundles.files(request.params.id, query.candidateId ?? null, query.path);
  });
  app.get<{ Params: { id: string } }>('/api/migration-bundles/:id/export', async (request, reply) => {
    const query = z
      .strictObject({ verified: z.enum(['true', 'false']).default('false') })
      .parse(request.query);
    return reply
      .type('application/zip')
      .header('content-disposition', 'attachment; filename="migration-bundle.zip"')
      .send(await bundles.export(request.params.id, query.verified === 'true'));
  });
}
