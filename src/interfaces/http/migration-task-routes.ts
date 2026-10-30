import type { FastifyInstance } from 'fastify';
import { registerTaskActivityRoutes } from './migration-activity-routes.js';
import { z } from 'zod';
import type { MigrationTaskService } from '../../migration/tasks/application/task-service.js';
import { stringify } from 'yaml';
import type { SkillStore } from '../../service/skill-store.js';
import { simpleMigrationSuiteExample } from '../../migration/domain/simple-migration-suite.js';
export function registerMigrationTaskRoutes(
  app: FastifyInstance,
  bundles: MigrationTaskService,
  privateWorkspaceEnabled: boolean,
  sourceAssets?: Pick<SkillStore,'uploadMigrationZip'>,
) {
  app.addHook('preValidation', async (request, reply) => {
    if (!privateWorkspaceEnabled && ['/api/migration-tasks'].some(prefix => request.url.startsWith(prefix)))
      return reply.code(403).send({ message: '整组迁移仅限私有工作区。' });
  });
  registerTaskActivityRoutes(app, bundles);
  for (const prefix of ['/api/migration-tasks']) {
    app.get(prefix+'/suite-example',()=>simpleMigrationSuiteExample);
    if(sourceAssets) app.post(prefix+'/assets',async request=>{
      if(!Buffer.isBuffer(request.body))throw Object.assign(new Error('请上传 Skill ZIP'),{statusCode:400});
      return sourceAssets.uploadMigrationZip(request.body);
    });
    const builder = () => { if (!bundles.builder) throw Object.assign(new Error('Builder 接入尚未配置'), { statusCode: 503 }); return bundles.builder; };
    app.post<{ Params: { id: string } }>(prefix + '/:id/runtime-build-requests', async request => {
      await builder().request(request.params.id, request.body, request.id); return bundles.get(request.params.id);
    });
    app.get<{ Params: { id: string } }>(prefix + '/:id/runtime-requirements.yaml', async (request, reply) => {
      const query = z.strictObject({ requestId: z.string().optional() }).parse(request.query);
      return reply.type('application/yaml; charset=utf-8').header('content-disposition', 'attachment; filename="runtime-build-requirements.yaml"')
        .send(stringify(await builder().requirements(request.params.id, query.requestId)));
    });
    app.post<{ Params: { id: string } }>(prefix + '/:id/runtime-deliveries', async request => {
      await builder().accept(request.params.id, request.body, request.id); return bundles.get(request.params.id);
    });
    app.delete<{ Params: { id: string } }>(prefix + '/:id/runtime-builder-selection', async request => {
      await builder().useExisting(request.params.id); return bundles.get(request.params.id);
    });
    app.get(prefix, () => bundles.list());
    app.post(prefix, (request) => bundles.create(request.body, request.id));
    app.post(prefix + '/upload', (request) => {
      if (!Buffer.isBuffer(request.body))
        throw Object.assign(new Error('请上传包含所选 Skill 及可选依赖的 ZIP'), { statusCode: 400 });
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
}
