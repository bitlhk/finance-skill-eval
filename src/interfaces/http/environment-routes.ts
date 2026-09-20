import type { FastifyInstance } from "fastify";
import type { EnvironmentStore } from "../../service/environment-store.js";

export function registerEnvironmentRoutes(app: FastifyInstance, environments: EnvironmentStore): void {
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
