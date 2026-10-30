import { readFile } from "node:fs/promises";
import {describeSkillRuntimeRequirements} from '../shared/skill-runtime-requirements.js';
import path from "node:path";
import { pathToFileURL } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { analyzeSkillAndGenerateCases } from "../analyzer.js";
import { FINANCE_SKILL_EVAL_VERSION } from "../index.js";
import { renderHtmlReport, type EvaluationReport } from "../report.js";
import { EvalPackCatalog } from "./catalog.js";
import { configuredModelRole, loadServiceConfig, type ServiceConfig } from "./config.js";
import { manualPreparationSchema, prepareSkillSchema } from "./contracts.js";
import {simpleMigrationSuiteSchema,simpleMigrationCases} from '../migration/domain/simple-migration-suite.js';
import { registerEnvironmentRoutes } from "../interfaces/http/environment-routes.js";
import { registerMigrationRoutes } from "../interfaces/http/migration-routes.js";
import { EnvironmentStore } from "./environment-store.js";
import {RuntimeDeliveryCoordinator} from './runtime-delivery-coordinator.js';
import { EvaluationJobStore } from "./job-store.js";
import { PreparationStore } from "./preparation-store.js";
import { EvaluationRunManager } from "./run-manager.js";
import { SkillStore } from "./skill-store.js";
import { OptimizationManager } from "./optimization-manager.js";
import { DemoAccess } from "./demo-access.js";
import { MigrationStore } from '../migration/migration-store.js';
import { MigrationDiagnostics } from '../migration/infrastructure/migration-diagnostics.js';
import type { MigrationAnalyzer, MigrationImplementer } from '../migration/application/migration-agent-port.js';
import type { MigrationSuiteGenerator } from '../migration/application/migration-suite-generator.js';
import type { ImprovementPlanner } from '../migration/application/migration-improvement-planning-service.js';
import type {ToolOptimizationProposer} from '../migration/application/migration-tool-optimization-service.js';
import type {MigrationReusePlanner} from '../migration/application/migration-reuse-planner.js';
import { runConfigurationSchema } from "./contracts.js";
import {createAccountWorkspaces} from './account-workspaces.js';
import {managedWorkspaceOperation} from './managed-workspace-policy.js';
import {EvaluationRunBudget} from './evaluation-run-budget.js';

function markdownReport(report: EvaluationReport): string {
  const cases = report.cases.map((item, index) => [
    `## ${index + 1}. ${item.name}`,
    "",
    `**任务：** ${item.prompt}`,
    "",
    `**结论：** ${item.judge?.winner === "right" ? "右侧更优" : item.judge?.winner === "left" ? "左侧更优" : item.judge ? "持平" : "Judge 未完成"}`,
    "",
    item.judge?.summary ?? item.judgeError ?? "无评价",
    "",
    "### 左侧输出",
    "",
    item.left.output,
    "",
    "### 右侧输出",
    "",
    item.right.output,
  ].join("\n")).join("\n\n");
  return [
    `# ${report.pack.targetSkillId} Skill 评测报告`,
    "",
    `- 结论：${report.summary.headline}`,
    `- Eval Pack：${report.pack.packId}@${report.pack.version}`,
    `- Runtime：${report.runtimeAdapterId}`,
    `- Judge：${report.judgeId}`,
    ...(report.questionSet ? [`- 题目来源：本轮 AI 生成，${report.questionSet.model.modelId}`, `- 冻结题集：${report.questionSet.fingerprint}`] : []),
    `- 报告指纹：${report.reportFingerprint}`,
    "",
    cases,
  ].join("\n");
}

function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.match(/^Bearer\s+(.+)$/iu)?.[1] ?? null;
}

export async function createEvaluationService(
  overrides: Partial<ServiceConfig> & {runBudget?:EvaluationRunBudget;migrationAnalyzer?:MigrationAnalyzer;migrationImplementer?:MigrationImplementer;migrationSuite?:MigrationSuiteGenerator;migrationImprovementPlanner?:ImprovementPlanner;migrationToolOptimizationProposer?:ToolOptimizationProposer;migrationReusePlanner?:MigrationReusePlanner} = {},
): Promise<FastifyInstance> {
  const {runBudget,migrationAnalyzer,migrationImplementer,migrationSuite,migrationImprovementPlanner,migrationToolOptimizationProposer,migrationReusePlanner,...configOverrides}=overrides;
  const config = { ...loadServiceConfig(), ...configOverrides };
  if(config.workspaceMode==='account'){
    const sharedBudget=new EvaluationRunBudget(config.maxConcurrentRuns);
    const app=await createAccountWorkspaces(config,child=>createEvaluationService({...overrides,...child,runBudget:sharedBudget}));
    await registerWeb(app,config);
    return app;
  }
  if(config.publicDemo && !config.accessToken) throw new Error("Public demo requires an ingress access token");
  if(config.workspaceSubject && (!config.accessToken || config.publicDemo || !/^studio_[a-zA-Z0-9_-]+$/.test(config.workspaceSubject)
      || !config.workspaceOrigin || new URL(config.workspaceOrigin).origin!==config.workspaceOrigin
      || !config.workspaceOrigin.startsWith('https://')))throw new Error('Single-owner workspace requires a trusted ingress credential, subject and HTTPS origin');
  const app = Fastify({ logger: true, bodyLimit: 8 * 1024 * 1024 });
  app.addHook('onSend',async(request,reply,payload)=>{
    if(request.url.startsWith('/api/')) reply.header('cache-control','no-store');
    return payload;
  });
  const catalog = new EvalPackCatalog(config.rootDirectory);
  const skills = new SkillStore(config.dataDirectory);
  const environments = new EnvironmentStore(config.dataDirectory,config.launcherTrust??[]);
  const preparations = new PreparationStore(config.dataDirectory);
  const jobs = new EvaluationJobStore(config.dataDirectory);
  await Promise.all([
    catalog.initialize(),
    skills.initialize(),
    environments.initialize(),
    preparations.initialize(),
    jobs.initialize(),
  ]);
  const manager:EvaluationRunManager = new EvaluationRunManager({
    catalog,
    preparations,
    skills,
    environments,
    jobs,
    maxConcurrentRuns: config.maxConcurrentRuns,
    managedWorkspace:config.managedWorkspace,
    runBudget,
    resolveMigrationRuntime:async runtimeId=>await environments.get(runtimeId),
    resolveServiceEnvironment:(reference,toolNames)=>migrations.resolveServiceEnvironment(reference,toolNames),
  });
  const optimizations = new OptimizationManager({ dataDirectory: config.dataDirectory, skills, jobs, runs: manager, catalog, preparations });
  const demo = new DemoAccess(config.dataDirectory);
  const diagnostics = new MigrationDiagnostics(config.rootDirectory,config.dataDirectory,skills);
  app.addHook('onClose',async()=>{await manager.close();await diagnostics.close();});
  const migrations:MigrationStore = new MigrationStore(config.dataDirectory,{skills,runs:manager,jobs,catalog,preparations,optimizers:optimizations,diagnostics,environments,
    analyzer:migrationAnalyzer,implementer:migrationImplementer,suiteGenerator:migrationSuite,improvementPlanner:migrationImprovementPlanner,
    toolOptimizationProposer:migrationToolOptimizationProposer,reusePlanner:migrationReusePlanner});
  const runtimeDeliveries=new RuntimeDeliveryCoordinator(migrations,environments);
  app.addHook('onClose',()=>migrations.shutdown());
  registerMigrationRoutes(app, {
    migrations,
    skills,
    environments,
    runtimeDeliveries,
    privateWorkspaceEnabled: !config.publicDemo && Boolean(config.accessToken),
  });

  app.post<{ Params: { jobId: string } }>("/api/runs/:jobId/optimize", async (request, reply) => reply.code(202).send(await optimizations.create(request.params.jobId)));
  app.get<{ Params: { jobId: string } }>("/api/runs/:jobId/optimization", async request => optimizations.forSource(request.params.jobId));
  app.get<{ Params: { id: string } }>("/api/optimizations/:id", async request => optimizations.get(request.params.id));
  app.post<{ Params: { id: string } }>("/api/optimizations/:id/reevaluate", async (request, reply) => reply.code(202).send(await optimizations.reevaluate(request.params.id)));
  app.post<{ Params: { id: string } }>("/api/optimizations/:id/final-verify", async (request, reply) => reply.code(202).send(await optimizations.finalVerify(request.params.id)));
  app.post<{ Params: { id: string }; Body: { decision: string } }>("/api/optimizations/:id/decision", async request => {
    const decision = request.body?.decision;
    if (decision !== "adopt" && decision !== "retain" && decision !== "cancel") throw Object.assign(new Error("Invalid decision"), { statusCode: 400 });
    return optimizations.decide(request.params.id, decision);
  });

  app.addContentTypeParser(
    ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  app.addHook("onRequest", async (request, reply) => {
    if (!config.accessToken || !request.url.startsWith("/api/") || request.url === "/api/health") return;
    if (bearerToken(request.headers.authorization) !== config.accessToken) {
      return reply.code(401).send({ error: "UNAUTHORIZED", message: "访问令牌无效" });
    }
    if(config.workspaceSubject){
      if(request.headers['x-demo-user']!==config.workspaceSubject)return reply.code(403).send({error:'WORKSPACE_OWNER_REQUIRED',message:'当前登录账号无权访问此工作区，请使用自己的工作区。'});
      if(!['GET','HEAD','OPTIONS'].includes(request.method) && request.headers.origin!==config.workspaceOrigin)
        return reply.code(403).send({error:'WORKSPACE_ORIGIN_REQUIRED',message:'请从工作区页面发起操作。'});
    }
  });
  app.addHook("preValidation", async (request, reply) => {
    if(config.managedWorkspace&&!managedWorkspaceOperation(request.method,request.routeOptions.url??request.url))
      return reply.code(403).send({error:'MANAGED_CONFIGURATION_REQUIRED',message:'此入口使用平台已配置的执行环境；新增接口或代码需由维护者审核接入。'});
    if(!config.publicDemo || !request.url.startsWith('/api/') || request.method==='GET') return;
    demo.identity(request.headers['x-demo-user']);
    const origin = request.headers.origin;
    if(origin && origin !== process.env.FINANCE_EVAL_PUBLIC_ORIGIN) return reply.code(403).send({message:'跨站请求不受支持。'});
    const route=request.url.split('?')[0] ?? '';
    if(request.method!=='POST' || !(route==='/api/runs' || /^\/api\/runs\/run-[a-z0-9-]+\/cancel$/.test(route) || /^\/api\/environments\/env-[a-z0-9-]+\/preflight$/.test(route))) {
      return reply.code(403).send({message:'公开演示仅开放精选技能对比；资产与环境由维护者管理。'});
    }
  });
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const status = "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : error.name === "ZodError" ? 400 : 500;
    return reply.code(status).send({
      error: status === 400 ? "INVALID_REQUEST" : "SERVICE_ERROR",
      message: error.message,
    });
  });

  app.get("/api/health", async () => ({
    status: "ready",
    service: "finance-skill-eval",
    deploymentMode: config.publicDemo ? 'curated-public-demo' : 'local-workspace',
    version: FINANCE_SKILL_EVAL_VERSION,
    time: new Date().toISOString(),
  }));

  app.get("/api/catalog", async () => {
    const [uploadedSkills, savedEnvironments, savedPreparations] = await Promise.all([
      skills.list(),
      environments.list({includeArchived:true}),
      preparations.list(),
    ]);
    const activeEnvironments=savedEnvironments.filter(environment=>!environment.archived);
    const executionResources=activeEnvironments.filter(environment=>environment.type==='execution_environment');
    const referencedLaunchers=new Set(executionResources.map(environment=>environment.launcherEnvironmentId));
    const selectableRuntimes=[...executionResources,...activeEnvironments.filter(environment=>environment.type==='runtime_launcher'&&!referencedLaunchers.has(environment.environmentId))];
    const executionRuntimes=(await Promise.all(selectableRuntimes.map(async environment=>{
      try {
      const resolved=await environments.resolveLauncher(environment);
      const inspection=await environments.inspect(environment);if(inspection.status!=='ready'||!inspection.capabilities)return null;
      const defaultModelId=resolved.defaultModelId??inspection.capabilities.defaultModelId;
      return {runtimeId:environment.environmentId,launcherEnvironmentId:resolved.launcher.environmentId,name:environment.name,runtimeType:resolved.launcher.runtimeType,endpoint:resolved.launcher.baseUrl,
        mcpEnvironmentIds:resolved.mcpEnvironmentIds,toolCount:inspection.toolCount,inspection,
        transport:'runtime_launcher' as const,defaultModelId,supportedSkillModes:inspection.capabilities.supportedSkillModes,
        models:inspection.capabilities.models.map(model=>({providerId:`runtime-launcher:${environment.environmentId}`,modelId:model.modelId,upstreamModelId:model.upstreamModelId,label:model.label??model.upstreamModelId,parameters:{},availability:'ready' as const,statusNote:'由 Runtime Launcher capabilities 提供'}))};
      } catch { return null; }
    }))).filter(item=>item!==null);
    const analyzer = configuredModelRole("ANALYZER");
    const execution = configuredModelRole("EXECUTION");
    const judge = configuredModelRole("JUDGE");
    const optimizer = configuredModelRole("OPTIMIZER");
    const evalPacks = catalog.list();
    const onlineRuntimeReady = executionRuntimes.length > 0;
    return {
      schemaVersion: "finance.skill-eval.catalog.v1",
      serviceVersion: FINANCE_SKILL_EVAL_VERSION,
      publicDemo: Boolean(config.publicDemo),
      managedWorkspace:Boolean(config.managedWorkspace),
      featuredSkills: catalog.listFeaturedSkills(onlineRuntimeReady).map(skill => ({ ...skill,
        evaluationStatus: skill.evaluationStatus === "pack_required" ? "pack_required" :
          onlineRuntimeReady && uploadedSkills.some(a => a.skillId === skill.skillId) ? "ready" : "environment_required" })),
      evalPacks,
      uploadedSkills:await Promise.all(uploadedSkills.map(async asset=>{
        try{
          const archive=await skills.readArchive(asset.assetId);
          return {...asset,runtimeRequirements:describeSkillRuntimeRequirements(Buffer.from(archive[asset.skillFile]!).toString('utf8'))};
        }
        catch{return {...asset,runtimeRequirements:{status:'invalid',tools:[],error:'无法读取该版本 Skill 声明'}};}
      })),
      preparations: savedPreparations.map(preparation => ({...preparation,
        deterministicReady: preparation.cases.length > 0 && preparation.cases.every(item =>
          item.rubric.length > 0 && item.rubric.every(rule => rule.allOf.length + rule.anyOf.length + rule.noneOf.length > 0)),
      })),
      environments: savedEnvironments,
      executionRuntimes,
      launcherTrustReferences:(config.launcherTrust??[]).map(({reference,label,baseUrlPrefix})=>({reference,label,baseUrlPrefix})),
      runtimes: [
        {
          id: "replay",
          label: "冻结证据回放",
          status: "ready",
          realExecution: false,
          description: "复核已固化的真实或受控运行证据，不重新调用 Agent。",
        },
        {
          id: "direct_model",
          label: "文本 Skill 直测",
          status: execution.configured ? "ready" : "configuration_required",
          realExecution: true,
          description: "适合不依赖工具的 Skill；同一模型分别在无 Skill 与装配 Skill 条件下执行。",
        },
        {
          id: "runtime_launcher",
          label: "在线执行环境",
          status: onlineRuntimeReady ? "ready" : "configuration_required",
          realExecution: true,
          description: "由 Runtime Launcher 启动隔离实例，并按执行环境装配模型与 MCP。",
        },
      ],
      modelRoles: {
        analyzer: { configured: analyzer.configured, model: analyzer.model },
        execution: { configured: executionRuntimes.length > 0, model: executionRuntimes[0]?.models.find(model=>model.modelId===executionRuntimes[0]?.defaultModelId) ?? execution.model },
        directExecution: { configured: execution.configured, model: execution.model },
        judge: { configured: judge.configured, model: judge.model },
        optimizer: { configured: optimizer.configured, model: optimizer.model },
      },
    };
  });

  app.post("/api/skills/upload", async request => {
    if (!Buffer.isBuffer(request.body)) throw new Error("Request body must be a Skill ZIP");
    return skills.uploadZip(request.body);
  });

  app.post<{ Params: { assetId: string } }>("/api/skills/:assetId/prepare", async request => {
    const input = prepareSkillSchema.parse(request.body ?? {});
    const skill = await skills.get(request.params.assetId);
    if (!skill) throw Object.assign(new Error("Skill asset not found"), { statusCode: 404 });
    const analyzer = configuredModelRole("ANALYZER");
    if (!analyzer.adapter) {
      throw Object.assign(new Error("出题模型未配置，可先手工创建试题或配置 Analyzer 模型。"), { statusCode: 503 });
    }
    const generated = await analyzeSkillAndGenerateCases({
      modelAdapter: analyzer.adapter,
      model: input.model ?? analyzer.model,
      skillId: skill.skillId,
      skillSource: await skills.readSource(skill.assetId),
      domainContext: input.domainContext,
      role: input.role,
      maximumCases: input.maximumCases,
    });
    return preparations.create({
      skill,
      summary: generated.summary,
      cases: generated.cases,
      source: "ai_generated",
      evaluationContext: generated.evaluationContext,
    });
  });

  app.post<{ Params: { assetId: string } }>("/api/skills/:assetId/prepare/import", async request => {
    const suite = simpleMigrationSuiteSchema.parse(request.body);
    const skill = await skills.get(request.params.assetId);
    if (!skill) throw Object.assign(new Error('Skill asset not found'), {statusCode:404});
    return preparations.create({skill,summary:suite.name,cases:simpleMigrationCases(suite),source:'manual'});
  });

  app.post<{ Params: { assetId: string } }>("/api/skills/:assetId/prepare/manual", async request => {
    const input = manualPreparationSchema.parse(request.body);
    const skill = await skills.get(request.params.assetId);
    if (!skill) throw Object.assign(new Error("Skill asset not found"), { statusCode: 404 });
    return preparations.create({
      skill,
      summary: input.summary,
      cases: input.cases,
      holdoutCases: input.holdoutCases,
      source: "manual",
    });
  });

  registerEnvironmentRoutes(app, environments);

  app.get<{ Querystring: { limit?: string } }>("/api/runs", async request => ({
    runs: jobs.list(Number.parseInt(request.query.limit ?? "50", 10)),
  }));
  app.get<{ Params: { jobId: string } }>("/api/runs/:jobId", async request => {
    const job = jobs.get(request.params.jobId);
    if (!job) throw Object.assign(new Error("Evaluation run not found"), { statusCode: 404 });
    return job;
  });
  app.post("/api/runs", async (request, reply) => {
    const input=runConfigurationSchema.parse(request.body);
    if(!config.publicDemo) return reply.code(202).send(await manager.create(input));
    if(input.runtimeToolConfig) return reply.code(403).send({message:'运行上下文与鉴权配置仅限私有工作区。'});
    if (input.runtimeBindings) return reply.code(403).send({message:'逐侧 Runtime 迁移仅限私有工作区。'});
    const pack=catalog.list().find(p=>p.packId===input.packId);
    const runtime=input.runtime.type==='runtime_launcher' ? await environments.get(input.runtime.environmentId) : null;
    if(!pack || !pack.packId.endsWith('-online-v1') || !runtime || !['runtime_launcher','execution_environment'].includes(runtime.type) || input.preparationId || input.skillAssetId || input.includeHoldout) {
      return reply.code(400).send({message:'请选择预制在线评测包与已配置环境。'});
    }
    const assets=await skills.list();
    for(const variant of [input.leftVariant,input.rightVariant]) {
      if(!variant) continue;
      if(variant.skillId!==pack.targetSkillId || (variant.mode==='skill_version' && !assets.some(a=>a.skillId===variant.skillId&&a.version===variant.version&&(!variant.artifactSha256||a.artifactSha256===variant.artifactSha256)))) {
        return reply.code(400).send({message:'只能比较当前精选技能的已装配版本。'});
      }
    }
    const normalized={...input,judgeMode:'model',timeoutMs:310000,judgeModel:configuredModelRole('JUDGE').model};
    const job=await demo.create(demo.identity(request.headers['x-demo-user']),()=>jobs.list(100).filter(j=>['queued','preparing','running','judging'].includes(j.status)).length,()=>manager.create(normalized));
    return reply.code(202).send(job);
  });
  app.post<{ Params: { jobId: string } }>("/api/runs/:jobId/cancel", async request => {
    if(config.publicDemo) await demo.assertOwner(demo.identity(request.headers['x-demo-user']),request.params.jobId);
    return manager.cancel(request.params.jobId);
  });
  app.post<{ Params: { jobId: string } }>("/api/runs/:jobId/retry", async (request, reply) => (
    reply.code(202).send(await manager.retry(request.params.jobId))
  ));
  app.get<{ Params: { jobId: string } }>("/api/runs/:jobId/events", async (request, reply) => {
    const job = jobs.get(request.params.jobId);
    if (!job) throw Object.assign(new Error("Evaluation run not found"), { statusCode: 404 });
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (value: unknown) => reply.raw.write(`event: job\ndata: ${JSON.stringify(value)}\n\n`);
    send(job);
    const unsubscribe = manager.subscribe(job.jobId, current => send(current));
    const keepAlive = setInterval(() => reply.raw.write(": keepalive\n\n"), 15_000);
    request.raw.once("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });
  app.get<{
    Params: { jobId: string };
    Querystring: { format?: string };
  }>("/api/runs/:jobId/export", async (request, reply) => {
    const job = jobs.get(request.params.jobId);
    if (!job?.report) throw Object.assign(new Error("Evaluation report is unavailable"), { statusCode: 404 });
    const format = request.query.format ?? "json";
    if (format === "html") return reply.type("text/html; charset=utf-8").send(renderHtmlReport(job.report));
    if (format === "md") return reply.type("text/markdown; charset=utf-8").send(markdownReport(job.report));
    return reply.type("application/json").send(job.report);
  });

  await registerWeb(app,config);
  return app;
}

async function registerWeb(app:FastifyInstance,config:ServiceConfig){
  try {
    await readFile(path.join(config.publicDirectory, "index.html"));
    await app.register(fastifyStatic, {
      root: config.publicDirectory,
      prefix: "/",
      wildcard: true,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "NOT_FOUND", message: "API route not found" });
      }
      if (request.url.startsWith("/assets/")) return reply.code(404).send({ error: "NOT_FOUND", message: "Asset not found; reload the page" });
      return reply.sendFile("index.html");
    });
  } catch {
    app.get("/", async (_request, reply) => reply.type("text/plain").send(
      "Finance Skill Eval service is ready. Build the web console with pnpm build:web.",
    ));
  }
}

async function main(): Promise<void> {
  const config = loadServiceConfig();
  const app = await createEvaluationService(config);
  app.log.info({dataDirectory: config.dataDirectory, workspaceMode: config.workspaceMode}, 'Workspace data source');
  await app.listen({ host: config.host, port: config.port });
}

const isEntryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (isEntryPoint) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
