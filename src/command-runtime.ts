import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  RuntimeAdapter,
  RuntimeExecutionRequest,
} from "./adapters.js";
import {
  fingerprint,
  type RuntimeExecutionEvidence,
} from "./contracts.js";

const commandOutputSchema = z.object({
  schemaVersion: z.string().min(1),
  caseId: z.string().min(1),
  variant: z.string().min(1),
  modelId: z.string().min(1),
  output: z.string(),
  elapsedMs: z.number().nonnegative(),
  toolCalls: z.array(z.strictObject({
    name: z.string().min(1),
    status: z.enum(["completed", "failed"]),
  })).default([]),
  loadedSkills: z.array(z.strictObject({
    skillId: z.string().min(1),
    version: z.string().min(1),
  })).default([]),
  solutionId: z.string().min(1).optional(),
  solutionLock: z.unknown().optional(),
  runtimeIdentityVerified: z.boolean(),
  streamCompleted: z.boolean(),
  usage: z.strictObject({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    totalTokens: z.number().nonnegative().optional(),
  }).nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export type CommandRuntimeInvocation = {
  request: RuntimeExecutionRequest;
  promptFile: string;
  outputFile: string;
};

export type CommandRuntimeOptions = {
  adapterId: string;
  command: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
  argumentsFor(invocation: CommandRuntimeInvocation): string[];
  prepare?: () => Promise<void>;
  cleanup?: () => Promise<void>;
};

/** Executes a Candidate through a command boundary and maps its JSON result into canonical evidence. */
export class CommandRuntimeAdapter implements RuntimeAdapter {
  readonly adapterId: string;

  constructor(private readonly options: CommandRuntimeOptions) {
    this.adapterId = options.adapterId;
  }

  async prepare(): Promise<void> {
    await this.options.prepare?.();
  }

  async cleanup(): Promise<void> {
    await this.options.cleanup?.();
  }

  async execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionEvidence> {
    const directory = await mkdtemp(path.join(tmpdir(), "finance-skill-eval-command-"));
    const promptFile = path.join(directory, "prompt.txt");
    const outputFile = path.join(directory, "execution.json");
    await writeFile(promptFile, `${request.evalCase.prompt.trim()}\n`, "utf8");
    try {
      const args = this.options.argumentsFor({ request, promptFile, outputFile });
      await runCommand({
        command: this.options.command,
        args,
        cwd: this.options.cwd,
        environment: this.options.environment,
        timeoutMs: this.options.timeoutMs ?? 310_000,
      });
      const parsed = commandOutputSchema.parse(JSON.parse(await readFile(outputFile, "utf8")));
      if (parsed.caseId !== request.evalCase.caseId) {
        throw new Error(`Command output caseId mismatch: ${parsed.caseId}`);
      }
      const metadata = {
        ...this.options.metadata,
        ...parsed.metadata,
        executionMode: "command",
        ...(parsed.solutionId ? { solutionId: parsed.solutionId } : {}),
        ...(parsed.solutionLock === undefined ? {} : { solutionLock: parsed.solutionLock }),
      };
      return {
        runId: request.runId,
        side: request.side,
        caseId: request.evalCase.caseId,
        status: "completed",
        modelId: parsed.modelId,
        skillVersion: request.variant.mode === "skill_version" ? request.variant.version : null,
        output: parsed.output,
        elapsedMs: parsed.elapsedMs,
        toolCalls: parsed.toolCalls,
        loadedSkills: parsed.loadedSkills,
        usage: parsed.usage ?? null,
        runtimeIdentityVerified: parsed.runtimeIdentityVerified,
        streamCompleted: parsed.streamCompleted,
        error: null,
        traceFingerprint: fingerprint({
          caseId: parsed.caseId,
          side: request.side,
          output: parsed.output,
          toolCalls: parsed.toolCalls,
          solutionLock: parsed.solutionLock,
        }),
        metadata,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function runCommand(input: {
  command: string;
  args: string[];
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.environment },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      if (stderr.length < 16_000) stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${input.timeoutMs}ms`));
      } else if (code !== 0) {
        reject(new Error(`Command exited with code ${code}: ${stderr.trim()}`));
      } else {
        resolve();
      }
    });
  });
}
