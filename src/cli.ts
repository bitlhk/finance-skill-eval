#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEvalPack } from "./eval-pack.js";
import { DeterministicRubricJudge } from "./judge.js";
import { renderHtmlReport } from "./report.js";
import { ReplayRuntimeAdapter } from "./replay.js";
import { runEvaluation } from "./runner.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "replay") {
    throw new Error("Usage: finance-skill-eval replay --pack <eval.yaml> --out <directory>");
  }
  const packFile = option(args, "--pack");
  const outputDir = option(args, "--out");
  if (!packFile || !outputDir) {
    throw new Error("Both --pack and --out are required");
  }
  const pack = await loadEvalPack(packFile);
  const report = await runEvaluation({
    pack,
    runtime: new ReplayRuntimeAdapter(pack),
    judge: new DeterministicRubricJudge(),
    onProgress: progress => {
      process.stdout.write(`[${progress.stage}] ${progress.completedRuns}/${progress.totalRuns}\n`);
    },
  });
  const resolvedOutput = path.resolve(outputDir);
  await mkdir(resolvedOutput, { recursive: true });
  await writeFile(
    path.join(resolvedOutput, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(resolvedOutput, "report.html"), renderHtmlReport(report), "utf8");
  process.stdout.write(`${report.summary.headline}\n${resolvedOutput}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
