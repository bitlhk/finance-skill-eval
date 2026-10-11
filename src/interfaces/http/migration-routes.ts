import type { FastifyInstance } from "fastify";
import { resolveMigrationRuntimeSelection } from './migration-runtime-selection.js';
import type { EnvironmentStore } from "../../service/environment-store.js";
import type { MigrationStore } from "../../migration/migration-store.js";
import { simpleMigrationSuiteExample } from "../../migration/domain/simple-migration-suite.js";
import type { SkillStore } from "../../service/skill-store.js";
import { z } from 'zod';
import type {ModelRef} from '../../contracts.js';
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
  app.get<{Params:{id:string};Querystring:{environmentId:string}}>("/api/migrations/:id/native-tools",async request=>{
    await migrations.get(request.params.id);
    const query=z.strictObject({environmentId:z.string().min(1)}).parse(request.query);
    return environments.nativeToolCatalog(query.environmentId);
  });
  app.post<{Params:{id:string}}>("/api/migrations/:id/native-candidate",async request=>{
    const body=z.strictObject({baseAssetId:z.string().min(1),tools:z.array(z.string()),acknowledgeContracts:z.literal(true),
      targets:z.array(z.strictObject({environmentId:z.string().min(1),catalogDigest:z.string().regex(/^[a-f0-9]{64}$/u)})).min(1).max(2)}).parse(request.body);
    const targets=[];
    for(const target of body.targets){
      const current=await environments.nativeToolCatalog(target.environmentId);
      if(current.catalog.catalogDigest!==target.catalogDigest)throw Object.assign(new Error('工具目录已变化，请重新查看合同后确认'),{statusCode:409});
      targets.push(current);
    }
    return migrations.nativeCandidate(request.params.id,{baseAssetId:body.baseAssetId,tools:body.tools,acknowledgeContracts:body.acknowledgeContracts},targets);
  });
  app.get<{ Params: { id: string } }>("/api/migrations/:id", request => migrations.get(request.params.id));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/analyze", request => migrations.analyze(request.params.id));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/diagnose", request => migrations.diagnose(request.params.id, true));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/diagnosis", request => migrations.diagnose(request.params.id));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/inspect", request => migrations.inspect(request.params.id));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/inspect/source", request => {
    const body=z.strictObject({environmentId:z.string().min(1).optional()}).parse(request.body??{});
    return migrations.inspect(request.params.id,true,body.environmentId);
  });
  app.post<{Params:{id:string}}>('/api/migrations/:id/runtime-reuse',request=>migrations.reuseRuntime(request.params.id,request.body));
  app.get<{Params:{id:string}}>('/api/migrations/:id/reuse-acceptance',request=>migrations.reuseAcceptance(request.params.id));
  app.post<{Params:{id:string}}>('/api/migrations/:id/reuse-acceptance/plan',request=>migrations.proposeReuseAcceptance(request.params.id,request.body,requestSignal(request)));
  app.post<{Params:{id:string}}>('/api/migrations/:id/reuse-acceptance/approve',request=>migrations.approveReuseAcceptance(request.params.id,request.body));
  app.post<{Params:{id:string}}>('/api/migrations/:id/reuse-acceptance/start',request=>migrations.startReuseAcceptance(request.params.id,request.body));
  app.post<{Params:{id:string;taskId:string}}>('/api/migrations/:id/reuse-acceptance/:taskId/cancel',request=>migrations.cancelReuseAcceptance(request.params.id,request.params.taskId));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/runtime-configuration", request => migrations.runtimeConfiguration(request.params.id));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/runtime-requirements", request => {
    const query=z.strictObject({runtimeType:z.enum(['openjiuwen','agentscope','ea','generic_http']).optional()}).parse(request.query);
    return migrations.runtimeRequirements(request.params.id,query.runtimeType);
  });
  app.post<{ Params: { id: string } }>("/api/migrations/:id/runtime-rebuilds", request => migrations.proposeRuntimeRebuild(request.params.id,request.body));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/improvement-plans", request => migrations.proposeImprovement(request.params.id,request.body));
  app.get<{Params:{id:string}}>('/api/migrations/:id/improvement-tasks',request=>migrations.improvementTasks(request.params.id));
  app.post<{Params:{id:string}}>('/api/migrations/:id/improvement-tasks',request=>migrations.startImprovementTask(request.params.id,request.body));
  app.post<{Params:{id:string;taskId:string}}>('/api/migrations/:id/improvement-tasks/:taskId/cancel',request=>migrations.cancelImprovementTask(request.params.id,request.params.taskId));
  app.post<{Params:{id:string;taskId:string}}>('/api/migrations/:id/improvement-tasks/:taskId/adopt',request=>migrations.adoptImprovementTask(request.params.id,request.params.taskId));
  app.post<{Params:{id:string;taskId:string}}>('/api/migrations/:id/improvement-tasks/:taskId/resume',request=>migrations.resumeImprovementTask(request.params.id,request.params.taskId,request.body));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/tool-optimizations", request => migrations.proposeToolOptimization(request.params.id,request.body));
  app.post<{ Params: { id: string; attemptId:string } }>("/api/migrations/:id/tool-optimizations/:attemptId/adopt", request =>
    migrations.adoptToolOptimization(request.params.id,{attemptId:request.params.attemptId}));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/runtime-deliveries", async request => {
    const body=z.strictObject({result:z.unknown(),trustReference:z.string().regex(/^[a-z0-9-]+$/u),name:z.string().trim().min(1).max(80).optional()}).parse(request.body);
    return runtimeDeliveries.acceptAndBind(request.params.id,{result:body.result,trustReference:body.trustReference,name:body.name});
  });
  app.get<{ Params: { id: string } }>("/api/migrations/:id/runtime-requirements.yaml", async (request, reply) => {
    const query=z.strictObject({runtimeType:z.enum(['openjiuwen','agentscope','ea','generic_http']).optional()}).parse(request.query);
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
  app.post<{ Params: { id: string } }>("/api/migrations/:id/plan/proposal", request => migrations.proposeMigrationPlan(request.params.id,request.body));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/plan/approval", request => migrations.approveMigrationPlan(request.params.id,request.body));
  app.post<{ Params: { id: string } }>("/api/migrations/:id/generate", request => migrations.generate(request.params.id, request.body));
  app.get<{ Params: { id: string } }>("/api/migrations/:id/generation-progress", request => migrations.generationProgress(request.params.id));
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
    let leftExecutionModel=executionModel;
    if((configuration as Record<string,unknown>).evaluationMode==='solution_comparison'){
      const leftId=(configuration as {runtimeBindings?:{left?:{environmentId?:string}}}).runtimeBindings?.left?.environmentId;
      const leftEnvironment=leftId?await environments.get(leftId):null;
      if(!leftEnvironment||!['runtime_launcher','execution_environment'].includes(leftEnvironment.type))throw Object.assign(new Error('旧版 Runtime Launcher 不可用。'),{statusCode:400});
      const leftInspection=await environments.inspect(leftEnvironment),leftCapabilities=leftInspection.capabilities;
      if(leftInspection.status!=='ready'||!leftCapabilities)throw Object.assign(new Error(leftInspection.error??'旧版 Runtime Launcher 预检失败。'),{statusCode:400});
      const leftRequested=(configuration as {leftExecutionModel?:ModelRef}).leftExecutionModel?.modelId??leftCapabilities.defaultModelId;
      const leftModel=leftCapabilities.models.find(item=>item.modelId===leftRequested);
      if(!leftModel)throw Object.assign(new Error('旧版执行模型不属于所选 Launcher。'),{statusCode:400});
      leftExecutionModel={providerId:`runtime-launcher:${leftEnvironment.environmentId}`,modelId:leftModel.modelId,label:leftModel.label??leftModel.upstreamModelId,parameters:{}};
    }
    return migrations.validateOpenJiuwen(request.params.id, { ...(request.body as Record<string, unknown>), configuration: {
      ...configuration, executionModel, leftExecutionModel, rightExecutionModel: executionModel,
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
    const packaged=await migrations.exportPackage(request.params.id),report=await migrations.report(request.params.id);
    const name = packaged.skillId.replace(/[^a-z0-9-]+/giu, "-");
    const current=report.project.candidate?.artifactSha256===packaged.candidateDigest;
    const verified = current&&report.verification.delivery.status === "VERIFIED";
    return reply.type("application/zip").header("x-migration-acceptance", verified?'VERIFIED':'UNVERIFIED')
      .header("x-migration-candidate-digest", packaged.candidateDigest)
      .header("x-migration-business-acceptance", current?report.verification.targetExecution:'STALE')
      .header("x-migration-reuse-acceptance", current?report.verification.reuseAcceptance:'STALE')
      .header("content-disposition", `attachment; filename="${name}${verified ? "" : "-unverified"}.zip"`)
      .send(packaged.archive);
  });
}
