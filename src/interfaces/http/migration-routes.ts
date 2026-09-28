import type { FastifyInstance } from "fastify";
import type { ModelRef } from "../../contracts.js";
import type { EnvironmentStore } from "../../service/environment-store.js";
import type { MigrationStore } from "../../migration/migration-store.js";
import { simpleMigrationSuiteExample } from "../../migration/domain/simple-migration-suite.js";
import type { SkillStore } from "../../service/skill-store.js";

type MigrationRouteDependencies = {
  migrations: MigrationStore;
  skills: SkillStore;
  environments: EnvironmentStore;
  privateWorkspaceEnabled: boolean;
};

function requestSignal(request: { raw: NodeJS.EventEmitter }): AbortSignal {
  const controller = new AbortController();
  request.raw.once("aborted", () => controller.abort());
  return controller.signal;
}

export function registerMigrationRoutes(app: FastifyInstance, dependencies: MigrationRouteDependencies): void {
  const { migrations, skills, environments, privateWorkspaceEnabled } = dependencies;

  app.addHook("preValidation", async (request, reply) => {
    if (!privateWorkspaceEnabled && request.url.startsWith("/api/migrations")) {
      return reply.code(403).send({ message: "迁移资产仅限配置访问令牌的私有工作区。" });
    }
  });

  app.get("/api/migrations", () => migrations.list());
  app.get("/api/migrations/target", () => migrations.target());
  app.post("/api/migrations/upload", async request => {
    if (!Buffer.isBuffer(request.body)) throw new Error("Request body must be a migration ZIP");
    return skills.uploadMigrationZip(request.body);
  });
  app.post("/api/migrations", request => migrations.create(request.body));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/upgrade", request => migrations.upgrade(request.params.id));
  app.get<{ Params: { id: string } }>("/api/migrations/:id", request => migrations.get(request.params.id));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/analyze", request => migrations.analyze(request.params.id));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/diagnose", request => migrations.diagnose(request.params.id, true));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/diagnosis", request => migrations.diagnose(request.params.id));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/inspect", request => migrations.inspect(request.params.id));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/inspect/source", request => migrations.inspect(request.params.id, true));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/runtime-configuration", request => migrations.runtimeConfiguration(request.params.id));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/runtime-requirements", request => migrations.runtimeRequirements(request.params.id));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/runtime-requirements.yaml", async (request, reply) => reply
    .type("application/yaml; charset=utf-8")
    .header("content-disposition", 'attachment; filename="runtime-build-requirements.yaml"')
    .send(await migrations.runtimeRequirementsYaml(request.params.id)));
  app.put<{ Params: { id: string; dependencyId: string } }>("/api/migrations/:id/runtime-configuration/:dependencyId", request =>
    migrations.saveRuntimeDependency(request.params.id, request.params.dependencyId, request.body));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/check-business-connection", request =>
    migrations.checkBusinessConnection(request.params.id, request.body, requestSignal(request)));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/inspection", request => migrations.inspection(request.params.id));
  app.get<{ Params: { id: string; dependencyId: string } }>("/api/migrations/:id/dependencies/:dependencyId/data", request =>
    migrations.dependencyData(request.params.id, request.params.dependencyId));
  app.put<{ Params: { id: string; dependencyId: string } }>("/api/migrations/:id/dependencies/:dependencyId/data", request =>
    migrations.supplementDependency(request.params.id, request.params.dependencyId, request.body));
  app.put<{ Params: { id: string; dependencyId: string } }>("/api/migrations/:id/dependencies/:dependencyId/explanation", request =>
    migrations.explainDependency(request.params.id, request.params.dependencyId, request.body));
  app.post<{ Params: { id: string; dependencyId: string }; Querystring: { revision: string; filename: string } }>("/api/migrations/:id/dependencies/:dependencyId/file", request => {
    if (!Buffer.isBuffer(request.body)) throw Object.assign(new Error("请上传文件"), { statusCode: 400 });
    return migrations.uploadDependency(request.params.id, request.params.dependencyId, Number(request.query.revision), request.query.filename ?? "", request.body);
  });
  app.put<{ Params: { id: string; toolId: string } }>("/api/migrations/:id/tools/:toolId/decision", request =>
    migrations.decide(request.params.id, request.params.toolId, request.body));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/plan", request => migrations.plan(request.params.id));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/generate", request => migrations.generate(request.params.id, request.body));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/candidates", request => migrations.candidate(request.params.id, request.body));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/drafts", request => migrations.draft(request.params.id, request.body));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/validate", request => migrations.validate(request.params.id, request.body));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/verify-target", request => migrations.verifyTarget(request.params.id, request.body));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/validate/technical", request =>
    migrations.validateTechnical(request.params.id, request.body, requestSignal(request)));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/validations/technical", request => migrations.technicalValidations(request.params.id));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/validate/openjiuwen", async request => {
    const body = request.body as { configuration?: { runtime?: { type?: string; environmentId?: string }; executionModel?: ModelRef } };
    const configuration = body?.configuration;
    if (!configuration) return migrations.validateOpenJiuwen(request.params.id, request.body);
    if (configuration.runtime?.type !== "runtime_launcher" || !configuration.runtime.environmentId) {
      throw Object.assign(new Error("请选择 Runtime Launcher。"), { statusCode: 400 });
    }
    const environment = await environments.get(configuration.runtime.environmentId);
    if (!environment || !['runtime_launcher','execution_environment'].includes(environment.type)) throw Object.assign(new Error("执行环境不存在。"), { statusCode: 400 });
    const inspection = await environments.inspect(environment), capabilities = inspection.capabilities;
    if (inspection.status !== "ready" || !capabilities) throw Object.assign(new Error(inspection.error ?? "Runtime Launcher 预检失败。"), { statusCode: 400 });
    const requested = configuration.executionModel?.modelId ?? capabilities.defaultModelId;
    const model = capabilities.models.find(item => item.modelId === requested);
    if (!model) throw Object.assign(new Error("所选执行模型不属于这个 Runtime Launcher。"), { statusCode: 400 });
    const executionModel = { providerId: `runtime-launcher:${environment.environmentId}`, modelId: model.modelId, label: model.label ?? model.upstreamModelId, parameters: {} };
    return migrations.validateOpenJiuwen(request.params.id, { ...(request.body as Record<string, unknown>), configuration: {
      ...configuration, executionModel, leftExecutionModel: executionModel, rightExecutionModel: executionModel,
    } });
  });
  app.get<{ Params: { id: string } }>("/api/migrations/:id/validations/openjiuwen", request => migrations.openJiuwenValidations(request.params.id));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/review", request => migrations.review(request.params.id, request.body));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/suites", request => migrations.createSuite(request.params.id, request.body));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/suites/import", request => migrations.importSimpleSuite(request.params.id, request.body));
  app.get("/api/migration-suite-example", () => simpleMigrationSuiteExample);
  app.post<{ Params: { id: string } }>("/api/migrations/:id/suites/generated", request => migrations.generateSuite(request.params.id, request.body));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/optimize", request => migrations.optimize(request.params.id, request.body));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/optimized-candidate", request => migrations.adoptOptimization(request.params.id, request.body));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/report", request => migrations.report(request.params.id));
  app.post("/api/migrations/:id/releases", () => migrations.release());
  app.get<{ Params: { id: string } }>("/api/migrations/:id/export", async (request, reply) => {
    const report = await migrations.report(request.params.id), project = report.project;
    const name = (project.candidate ?? project.source).skillId.replace(/[^a-z0-9-]+/giu, "-");
    const verified = report.verification.targetExecution === "PASSED";
    return reply.type("application/zip").header("x-migration-acceptance", report.verification.targetExecution)
      .header("content-disposition", `attachment; filename="${name}${verified ? "" : "-unverified"}.zip"`)
      .send(await migrations.exportCandidate(request.params.id));
  });
}
