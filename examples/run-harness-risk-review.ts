import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  CommandRuntimeAdapter,
  DeterministicRubricJudge,
  loadEvalPack,
  ModelPairwiseJudge,
  OpenAiCompatibleModelAdapter,
  renderHtmlReport,
  runEvaluation,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const repository = path.resolve(process.env.FINANCE_HARNESS_REPOSITORY
    ?? path.join(process.cwd(), "../finance-agent-harness"));
  const packFile = path.resolve("packs/finance/risk-review/eval.yaml");
  const pack = await loadEvalPack(packFile);
  const modelApiKey = requiredEnvironment("FINANCE_AGENT_MODEL_API_KEY");
  const modelBaseUrl = requiredEnvironment("FINANCE_AGENT_MODEL_BASE_URL");
  const modelName = process.env.FINANCE_AGENT_MODEL ?? pack.models.execution.left.modelId;
  const examplePom = path.join(
    repository,
    "examples/solutions/openjiuwen-risk-review/pom.xml",
  );
  const runtime = new CommandRuntimeAdapter({
    adapterId: "finance-harness-openjiuwen-risk-review-v1",
    command: "mvn",
    cwd: repository,
    timeoutMs: 420_000,
    environment: {
      FINANCE_HARNESS_REPOSITORY: repository,
      FINANCE_AGENT_MODEL_API_KEY: modelApiKey,
      FINANCE_AGENT_MODEL_BASE_URL: modelBaseUrl,
      FINANCE_AGENT_MODEL: modelName,
    },
    metadata: {
      fixtureMode: "controlled",
      fixtureVersion: "risk-review-v1",
    },
    prepare: async () => {
      process.stdout.write("[preparing] compiling controlled OpenJiuwen Candidate\n");
      await execFileAsync("mvn", [
        "-q",
        "-pl",
        "examples/solutions/openjiuwen-risk-review",
        "-am",
        "install",
        "-DskipTests",
      ], { cwd: repository, maxBuffer: 1_000_000 });
    },
    argumentsFor: ({ request, promptFile, outputFile }) => {
      const variant = request.variant.mode === "without_target_skill"
        ? "without-domain"
        : "with-domain";
      return [
        "-q",
        "-f",
        examplePom,
        "exec:java",
        `-Dexec.args=--variant=${variant} --case-id=${request.evalCase.caseId} --prompt-file=${promptFile} --output-file=${outputFile}`,
      ];
    },
  });
  const judge = process.env.FINANCE_EVAL_JUDGE === "deterministic"
    ? new DeterministicRubricJudge()
    : new ModelPairwiseJudge(
      new OpenAiCompatibleModelAdapter({
        adapterId: "risk-review-judge-openai-compatible",
        apiKey: process.env.FINANCE_JUDGE_MODEL_API_KEY ?? modelApiKey,
        baseUrl: process.env.FINANCE_JUDGE_MODEL_BASE_URL ?? modelBaseUrl,
        timeoutMs: 240_000,
      }),
      {
        ...pack.models.judge,
        modelId: process.env.FINANCE_JUDGE_MODEL ?? pack.models.judge.modelId,
      },
    );
  const report = await runEvaluation({
    pack,
    runtime,
    judge,
    timeoutMs: 430_000,
    onProgress: progress => {
      const suffix = progress.caseId && progress.side
        ? ` ${progress.caseId}/${progress.side}`
        : "";
      process.stdout.write(
        `[${progress.stage}] ${progress.completedRuns}/${progress.totalRuns}${suffix}\n`,
      );
    },
  });
  const outputDirectory = path.resolve(
    process.env.FINANCE_EVAL_OUTPUT ?? "reports/risk-review/live",
  );
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outputDirectory, "report.html"),
    renderHtmlReport(report),
    "utf8",
  );
  process.stdout.write(`${report.summary.headline}\n${outputDirectory}\n`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
