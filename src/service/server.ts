import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { analyzeSkillAndGenerateCases } from "../analyzer.js";
import { FINANCE_SKILL_EVAL_VERSION } from "../index.js";
import { renderHtmlReport, type EvaluationReport } from "../report.js";
import { EvalPackCatalog } from "./catalog.js";
import { configuredModelRole, loadServiceConfig, type ServiceConfig } from "./config.js";
import { createEnvironmentSchema, manualPreparationSchema, prepareSkillSchema } from "./contracts.js";
import { EnvironmentStore } from "./environment-store.js";
import { EvaluationJobStore } from "./job-store.js";
import { PreparationStore } from "./preparation-store.js";
import { EvaluationRunManager } from "./run-manager.js";
import { SkillStore } from "./skill-store.js";

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
  overrides: Partial<ServiceConfig> = {},
): Promise<FastifyInstance> {
  const config = { ...loadServiceConfig(), ...overrides };
  const app = Fastify({ logger: true, bodyLimit: 8 * 1024 * 1024 });
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
    const judge = configuredModelRole("JUDGE");
    return {
      schemaVersion: "finance.skill-eval.catalog.v1",
      serviceVersion: FINANCE_SKILL_EVAL_VERSION,
      evalPacks: catalog.list(),
      uploadedSkills,
      preparations: savedPreparations,
      environments: savedEnvironments,
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
        execution: { configured: execution.configured, model: execution.model },
        judge: { configured: judge.configured, model: judge.model },
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
      return environments.preflight(environment);
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
  app.post("/api/runs", async (_request, reply) => reply.code(202).send(
    await manager.create(_request.body),
  ));
  app.post<{ Params: { jobId: string } }>("/api/runs/:jobId/cancel", async request => (
    manager.cancel(request.params.jobId)
  ));
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
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "NOT_FOUND", message: "API route not found" });
      }
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
