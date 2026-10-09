import type { FastifyInstance } from "fastify";
import type { EnvironmentStore } from "../../service/environment-store.js";
import { environmentListQuerySchema } from "../../shared/contracts/environment.js";

export function registerEnvironmentRoutes(app: FastifyInstance, environments: EnvironmentStore): void {
  app.get('/api/environments', async request => environments.list(environmentListQuerySchema.parse(request.query)));
  app.get<{ Params: { environmentId: string } }>('/api/environments/:environmentId', async request => {
    const environment=await environments.get(request.params.environmentId);
    if(!environment)throw Object.assign(new Error('Environment not found'),{statusCode:404});
    return environment;
  });
  app.patch<{ Params: { environmentId: string } }>('/api/environments/:environmentId/archive', async request =>
    environments.setArchived(request.params.environmentId, request.body));
  app.post("/api/environments", async request => environments.create(request.body));
  app.put<{ Params: { environmentId: string } }>("/api/environments/:environmentId", async request =>
    environments.update(request.params.environmentId, request.body));
  app.delete<{ Params: { environmentId: string } }>("/api/environments/:environmentId", async (request, reply) => {
    await environments.remove(request.params.environmentId);
    return reply.code(204).send();
  });
  app.post<{ Params: { environmentId: string } }>("/api/environments/:environmentId/preflight", async request => {
    const environment = await environments.get(request.params.environmentId);
    if (!environment) throw Object.assign(new Error("Environment not found"), { statusCode: 404 });
    return environments.inspect(environment);
  });
}
