import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { analyzeSkillAndGenerateCases } from "../analyzer.js";
import { FINANCE_SKILL_EVAL_VERSION } from "../index.js";
import { renderHtmlReport, type EvaluationReport } from "../report.js";
import { EvalPackCatalog } from "./catalog.js";
import { configuredModelRole, loadServiceConfig, type ConfiguredModelRole, type ServiceConfig } from "./config.js";
import { createEnvironmentSchema, manualPreparationSchema, prepareSkillSchema } from "./contracts.js";
import { EnvironmentStore } from "./environment-store.js";
import { EvaluationJobStore } from "./job-store.js";
import { PreparationStore } from "./preparation-store.js";
import { EvaluationRunManager } from "./run-manager.js";
import { SkillStore } from "./skill-store.js";
import { OptimizationManager } from "./optimization-manager.js";
import { DemoAccess } from "./demo-access.js";
import { MigrationStore } from './migration-store.js';
import { MigrationDiagnostics } from './migration-diagnostics.js';
import type { MigrationAnalyzer, MigrationImplementer } from './migration-agent.js';
import { runConfigurationSchema } from "./contracts.js";
import { executionModelCatalog, modelReference, resolvePublicExecutionModels } from "./execution-models.js";
import { MigrationCodeGenerator } from './migration-code-generator.js';

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
  overrides: Partial<ServiceConfig> & {migrationModel?:()=>ConfiguredModelRole;migrationAnalyzer?:MigrationAnalyzer;migrationImplementer?:MigrationImplementer} = {},
): Promise<FastifyInstance> {
  const {migrationModel,migrationAnalyzer,migrationImplementer,...configOverrides}=overrides;
  const config = { ...loadServiceConfig(), ...configOverrides };
  if(config.publicDemo && !config.accessToken) throw new Error("Public demo requires an ingress access token");
  const app = Fastify({ logger: true, bodyLimit: 8 * 1024 * 1024 });
  app.addHook('onSend',async(request,reply,payload)=>{
    if(request.url.startsWith('/api/')) reply.header('cache-control','no-store');
    return payload;
  });
  const catalog = new EvalPackCatalog(config.rootDirectory);
  const skills = new SkillStore(config.dataDirectory);
  const environments = new EnvironmentStore(config.dataDirectory);
  const preparations = new PreparationStore(config.dataDirectory);
  const jobs = new EvaluationJobStore(config.dataDirectory);
  await Promise.all([
    catalog.initialize(),
    skills.initialize(),
    environments.initialize(),
    preparations.initialize(),
    jobs.initialize(),
  ]);
  const manager = new EvaluationRunManager({
    catalog,
    preparations,
    skills,
    environments,
    jobs,
    maxConcurrentRuns: config.maxConcurrentRuns,
  });
  const optimizations = new OptimizationManager({ dataDirectory: config.dataDirectory, skills, jobs, runs: manager, catalog, preparations });
  const demo = new DemoAccess(config.dataDirectory);
  const diagnostics = new MigrationDiagnostics(config.rootDirectory,config.dataDirectory,skills);
  const migrations = new MigrationStore(config.dataDirectory,skills,manager,jobs,catalog,preparations,optimizations,diagnostics,environments,
    new MigrationCodeGenerator(migrationModel??(()=>configuredModelRole('MIGRATION'))),migrationAnalyzer,migrationImplementer);
  // Private workspace only. A public demo must not expose customer migration snapshots.
  app.addHook('preValidation',async(request,reply)=>{
    if ((config.publicDemo || !config.accessToken) && request.url.startsWith('/api/migrations')) return reply.code(403).send({message:'迁移资产仅限配置访问令牌的私有工作区。'});
  });
  app.get('/api/migrations',()=>migrations.list());
  app.get('/api/migrations/target',()=>migrations.target());
  app.post('/api/migrations/upload',async request=>{
    if(!Buffer.isBuffer(request.body))throw new Error('Request body must be a migration ZIP');
    return skills.uploadMigrationZip(request.body);
  });
  app.post('/api/migrations',request=>migrations.create(request.body));
  app.post<{Params:{id:string}}>('/api/migrations/:id/upgrade',request=>migrations.upgrade(request.params.id));
  app.get<{Params:{id:string}}>('/api/migrations/:id',request=>migrations.get(request.params.id));
  app.post<{Params:{id:string}}>('/api/migrations/:id/analyze',request=>migrations.analyze(request.params.id));
  app.post<{Params:{id:string}}>('/api/migrations/:id/diagnose',request=>migrations.diagnose(request.params.id,true));
  app.get<{Params:{id:string}}>('/api/migrations/:id/diagnosis',request=>migrations.diagnose(request.params.id));
  app.post<{Params:{id:string}}>('/api/migrations/:id/inspect',request=>migrations.inspect(request.params.id));
  app.get<{Params:{id:string}}>('/api/migrations/:id/inspection',request=>migrations.inspection(request.params.id));
  app.put<{Params:{id:string;toolId:string}}>('/api/migrations/:id/tools/:toolId/decision',request=>migrations.decide(request.params.id,request.params.toolId,request.body));
  app.get<{Params:{id:string}}>('/api/migrations/:id/plan',request=>migrations.plan(request.params.id));
  app.post<{Params:{id:string}}>('/api/migrations/:id/generate',request=>migrations.generate(request.params.id,request.body));
  app.post<{Params:{id:string}}>('/api/migrations/:id/candidates',request=>migrations.candidate(request.params.id,request.body));
  app.post<{Params:{id:string}}>('/api/migrations/:id/drafts',request=>migrations.draft(request.params.id,request.body));
  app.post<{Params:{id:string}}>('/api/migrations/:id/validate',request=>migrations.validate(request.params.id,request.body));
  app.post<{Params:{id:string}}>('/api/migrations/:id/verify-target',request=>migrations.verifyTarget(request.params.id,request.body));
  app.post<{Params:{id:string}}>('/api/migrations/:id/validate/technical',request=>{const controller=new AbortController();request.raw.once('aborted',()=>controller.abort());return migrations.validateTechnical(request.params.id,request.body,controller.signal);});
  app.get<{Params:{id:string}}>('/api/migrations/:id/validations/technical',request=>migrations.technicalValidations(request.params.id));
  app.post<{Params:{id:string}}>('/api/migrations/:id/validate/openjiuwen',request=>migrations.validateOpenJiuwen(request.params.id,request.body));
  app.get<{Params:{id:string}}>('/api/migrations/:id/validations/openjiuwen',request=>migrations.openJiuwenValidations(request.params.id));
  app.post<{Params:{id:string}}>('/api/migrations/:id/review',request=>migrations.review(request.params.id,request.body));
  app.post<{Params:{id:string}}>('/api/migrations/:id/suites',request=>migrations.createSuite(request.params.id,request.body));
  app.post<{Params:{id:string}}>('/api/migrations/:id/optimize',request=>migrations.optimize(request.params.id,request.body));
  app.post<{Params:{id:string}}>('/api/migrations/:id/optimized-candidate',request=>migrations.adoptOptimization(request.params.id,request.body));
  app.get<{Params:{id:string}}>('/api/migrations/:id/report',request=>migrations.report(request.params.id));
  app.post('/api/migrations/:id/releases',()=>migrations.release());
  app.get<{Params:{id:string}}>('/api/migrations/:id/export',async(request,reply)=>{
    const project=await migrations.get(request.params.id),name=(project.candidate??project.source).skillId.replace(/[^a-z0-9-]+/giu,'-');
    return reply.type('application/zip').header('content-disposition',`attachment; filename="${name}.zip"`).send(await migrations.exportCandidate(request.params.id));
  });

  app.post<{ Params: { jobId: string } }>("/api/runs/:jobId/optimize", async (request, reply) => reply.code(202).send(await optimizations.create(request.params.jobId)));
  app.get<{ Params: { jobId: string } }>("/api/runs/:jobId/optimization", async request => optimizations.forSource(request.params.jobId));
  app.get<{ Params: { id: string } }>("/api/optimizations/:id", async request => optimizations.get(request.params.id));
  app.post<{ Params: { id: string } }>("/api/optimizations/:id/reevaluate", async (request, reply) => reply.code(202).send(await optimizations.reevaluate(request.params.id)));
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
  });
  app.addHook("preValidation", async (request, reply) => {
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
      environments.list(),
      preparations.list(),
    ]);
    const analyzer = configuredModelRole("ANALYZER");
    const execution = configuredModelRole("EXECUTION");
    const executionCatalog = await executionModelCatalog();
    const executionDefault = executionCatalog?.models.find(m => m.modelId === executionCatalog.defaultModelId);
    const judge = configuredModelRole("JUDGE");
    const optimizer = configuredModelRole("OPTIMIZER");
    const evalPacks = catalog.list();
    const modelMap = new Map<string, { providerId: string; modelId: string; label?: string }>();
    for (const pack of evalPacks) {
      for (const model of [pack.models.execution.left, pack.models.execution.right]) {
        const key = `${model.providerId}:${model.modelId}`;
        if (!modelMap.has(key)) modelMap.set(key, { ...model, label: model.modelId });
      }
    }
    const executionKey = `${execution.model.providerId}:${execution.model.modelId}`;
    if (!modelMap.has(executionKey)) {
      modelMap.set(executionKey, { ...execution.model, label: execution.model.modelId });
    }
    const onlineRuntimeReady = savedEnvironments.some(item => item.type === "runtime_http");
    return {
      schemaVersion: "finance.skill-eval.catalog.v1",
      serviceVersion: FINANCE_SKILL_EVAL_VERSION,
      publicDemo: Boolean(config.publicDemo),
      featuredSkills: catalog.listFeaturedSkills(onlineRuntimeReady).map(skill => ({ ...skill,
        evaluationStatus: skill.evaluationStatus === "pack_required" ? "pack_required" :
          onlineRuntimeReady && uploadedSkills.some(a => a.skillId === skill.skillId) ? "ready" : "environment_required" })),
      evalPacks,
      uploadedSkills,
      preparations: savedPreparations,
      environments: savedEnvironments,
      models: executionCatalog?.models ?? (execution.configured ? [{ ...execution.model, label: execution.model.modelId }] : [...modelMap.values()]),
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
          id: "runtime_http",
          label: "外部 Agent Runtime",
          status: savedEnvironments.some(item => item.type === "runtime_http")
            ? "ready" : "configuration_required",
          realExecution: true,
          description: "通过标准 HTTP 合同调用 EA、OpenJiuwen Candidate 或其他 Agent Runtime。",
        },
      ],
      modelRoles: {
        analyzer: { configured: analyzer.configured, model: analyzer.model },
        execution: { configured: execution.configured || Boolean(executionDefault), model: executionDefault ? modelReference(executionDefault) : execution.model },
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

  app.post("/api/environments", async request => environments.create(
    createEnvironmentSchema.parse(request.body),
  ));
  app.post<{ Params: { environmentId: string } }>(
    "/api/environments/:environmentId/preflight",
    async request => {
      const environment = await environments.get(request.params.environmentId);
      if (!environment) throw Object.assign(new Error("Environment not found"), { statusCode: 404 });
      return environments.inspect(environment);
    },
  );

  app.get<{ Querystring: { limit?: string } }>("/api/runs", async request => ({
    runs: jobs.list(Number.parseInt(request.query.limit ?? "50", 10)),
  }));
  app.get<{ Params: { jobId: string } }>("/api/runs/:jobId", async request => {
    const job = jobs.get(request.params.jobId);
    if (!job) throw Object.assign(new Error("Evaluation run not found"), { statusCode: 404 });
    return job;
  });
  app.post("/api/runs", async (request, reply) => {
    if(!config.publicDemo) return reply.code(202).send(await manager.create(request.body));
    const input=runConfigurationSchema.parse(request.body);
    if (input.runtimeBindings) return reply.code(403).send({message:'逐侧 Runtime 迁移仅限私有工作区。'});
    const pack=catalog.list().find(p=>p.packId===input.packId);
    const runtime=input.runtime.type==='runtime_http' ? await environments.get(input.runtime.environmentId) : null;
    if(!pack || !pack.packId.endsWith('-online-v1') || !runtime || runtime.type!=='runtime_http' || input.preparationId || input.skillAssetId || input.includeHoldout) {
      return reply.code(400).send({message:'请选择预制在线评测包与已配置环境。'});
    }
    const execution=await resolvePublicExecutionModels(input);
    const assets=await skills.list();
    for(const variant of [input.leftVariant,input.rightVariant]) {
      if(!variant) continue;
      if(variant.skillId!==pack.targetSkillId || (variant.mode==='skill_version' && !assets.some(a=>a.skillId===variant.skillId&&a.version===variant.version&&(!variant.artifactSha256||a.artifactSha256===variant.artifactSha256)))) {
        return reply.code(400).send({message:'只能比较当前精选技能的已装配版本。'});
      }
    }
    const normalized={...input,judgeMode:'model',timeoutMs:310000,executionModel:undefined,...execution,judgeModel:configuredModelRole('JUDGE').model};
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
  return app;
}

async function main(): Promise<void> {
  const config = loadServiceConfig();
  const app = await createEvaluationService(config);
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
