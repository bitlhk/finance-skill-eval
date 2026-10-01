import type { FastifyInstance } from "fastify";
import { resolveMigrationRuntimeSelection } from './migration-runtime-selection.js';
import type { EnvironmentStore } from "../../service/environment-store.js";
import type { MigrationStore } from "../../migration/migration-store.js";
import { simpleMigrationSuiteExample } from "../../migration/domain/simple-migration-suite.js";
import type { SkillStore } from "../../service/skill-store.js";
import { z } from 'zod';
import type {RuntimeDeliveryCoordinator} from '../../service/runtime-delivery-coordinator.js';

type MigrationRouteDependencies = {
  migrations: MigrationStore;
  skills: SkillStore;
  environments: EnvironmentStore;
  runtimeDeliveries:RuntimeDeliveryCoordinator;
  privateWorkspaceEnabled: boolean;
};

function requestSignal(request: { raw: NodeJS.EventEmitter }): AbortSignal {
  const controller = new AbortController();
  request.raw.once("aborted", () => controller.abort());
  return controller.signal;
}

export function registerMigrationRoutes(app: FastifyInstance, dependencies: MigrationRouteDependencies): void {
  const { migrations, skills, environments, runtimeDeliveries, privateWorkspaceEnabled } = dependencies;

  app.addHook("preValidation", async (request, reply) => {
    if (!privateWorkspaceEnabled && request.url.startsWith("/api/migrations")) {
      return reply.code(403).send({ message: "迁移资产仅限配置访问令牌的私有工作区。" });
    }
  });

  app.get("/api/migrations", () => migrations.list());
  app.get("/api/migrations-legacy",()=>migrations.listLegacy());
  app.get<{Params:{id:string}}>("/api/migrations-legacy/:id/export",async(request,reply)=>reply
    .type("application/json; charset=utf-8")
    .header("content-disposition",`attachment; filename="${request.params.id}.legacy.json"`)
    .send(await migrations.readLegacy(request.params.id)));
  app.post("/api/migrations/upload", async request => {
    if (!Buffer.isBuffer(request.body)) throw new Error("Request body must be a migration ZIP");
    return skills.uploadMigrationZip(request.body);
  });
  app.post("/api/migrations", request => migrations.create(request.body));
  app.get<{ Params: { id: string } }>("/api/migrations/:id", request => migrations.get(request.params.id));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/analyze", request => migrations.analyze(request.params.id));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/diagnose", request => migrations.diagnose(request.params.id, true));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/diagnosis", request => migrations.diagnose(request.params.id));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/inspect", request => migrations.inspect(request.params.id));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/inspect/source", request => migrations.inspect(request.params.id, true));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/runtime-configuration", request => migrations.runtimeConfiguration(request.params.id));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/runtime-requirements", request => {
    const query=z.strictObject({runtimeType:z.enum(['openjiuwen','agentscope']).optional()}).parse(request.query);
    return migrations.runtimeRequirements(request.params.id,query.runtimeType);
  });
  app.post<{ Params: { id: string } }>("/api/migrations/:id/runtime-deliveries", async request => {
    const body=z.strictObject({result:z.unknown(),trustReference:z.string().regex(/^[a-z0-9-]+$/u),name:z.string().trim().min(1).max(80).optional()}).parse(request.body);
    return runtimeDeliveries.acceptAndBind(request.params.id,{result:body.result,trustReference:body.trustReference,name:body.name});
  });
  app.get<{ Params: { id: string } }>("/api/migrations/:id/runtime-requirements.yaml", async (request, reply) => {
    const query=z.strictObject({runtimeType:z.enum(['openjiuwen','agentscope']).optional()}).parse(request.query);
    return reply
    .type("application/yaml; charset=utf-8")
    .header("content-disposition", 'attachment; filename="runtime-build-requirements.yaml"')
    .send(await migrations.runtimeRequirementsYaml(request.params.id,query.runtimeType));
  });
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
  app.post<{ Params: { id: string } }>("/api/migrations/:id/validate", async request => {
    const body=request.body as {pair?:unknown;configuration?:{evaluationMode?:unknown}}|null;
    if(body?.pair==='CC'||body?.configuration?.evaluationMode==='candidate_runtime_comparison')
      return migrations.validateOpenJiuwen(request.params.id,await resolveMigrationRuntimeSelection(request.body,environments));
    return migrations.validate(request.params.id,request.body);
  });
  app.post<{ Params: { id: string } }>("/api/migrations/:id/validate/technical", request =>
    migrations.validateTechnical(request.params.id, request.body, requestSignal(request)));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/validations/technical", request => migrations.technicalValidations(request.params.id));
  for(const route of ['runtime','openjiuwen'])app.post<{ Params: { id: string } }>(`/api/migrations/:id/validate/${route}`,async request => {
    if(!(request.body as {configuration?:unknown}|null)?.configuration)return migrations.validateOpenJiuwen(request.params.id,request.body);
    return migrations.validateOpenJiuwen(request.params.id,await resolveMigrationRuntimeSelection(request.body,environments));
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
