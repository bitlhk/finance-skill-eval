import { spawn } from "node:child_process";
import type {
  ModelAdapter,
  ModelCompletionRequest,
  ModelCompletionResponse,
} from "./adapters.js";

export type CodexCliModelOptions = {
  adapterId?: string;
  executable?: string;
  cwd?: string;
  timeoutMs?: number;
};

type CodexJsonEvent = {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

export function parseCodexJsonOutput(output: string): {
  content: string;
  usage?: ModelCompletionResponse["usage"];
} {
  const events = output.split(/\r?\n/u).flatMap(line => {
    try { return [JSON.parse(line) as CodexJsonEvent]; } catch { return []; }
  });
  const content = events
    .filter(event => event.type === "item.completed" && event.item?.type === "agent_message")
    .map(event => event.item?.text ?? "")
    .filter(Boolean)
    .at(-1);
  if (!content) throw new Error("Codex Judge returned no final message");
  const rawUsage = [...events].reverse().find(event => event.type === "turn.completed")?.usage;
  return {
    content,
    usage: rawUsage ? {
      inputTokens: rawUsage.input_tokens,
      outputTokens: rawUsage.output_tokens,
      totalTokens: (rawUsage.input_tokens ?? 0) + (rawUsage.output_tokens ?? 0),
    } : undefined,
  };
}

function judgePrompt(request: ModelCompletionRequest): string {
  return [
    "You are a stateless model completing the role specified in the following system message (judge or skill optimizer).",
    "Do not call tools, inspect files, or modify the workspace.",
    request.responseFormat === "json"
      ? "Return only the JSON object requested by the messages, with no markdown fence."
      : "Return only the requested answer.",
    "",
    ...request.messages.map(message => `[${message.role.toUpperCase()}]\n${message.content}`),
  ].join("\n\n");
}

/** Optional Judge adapter backed by the authenticated Codex CLI on this host. */
export class CodexCliModelAdapter implements ModelAdapter {
  readonly adapterId: string;

  constructor(private readonly options: CodexCliModelOptions = {}) {
    this.adapterId = options.adapterId ?? "codex-cli-model-v1";
  }

  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResponse> {
    request.signal?.throwIfAborted();
    const args = [
      "--ask-for-approval", "never",
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--ignore-user-config",
      "--sandbox", "read-only",
      "--model", request.model.modelId,
      "--json",
      "-",
    ];
    const result = await new Promise<{ output: string; error: string }>((resolve, reject) => {
      const child = spawn(this.options.executable ?? "codex", args, {
        cwd: this.options.cwd ?? process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let output = "";
      let error = "";
      let stopReason: unknown;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* The process may already have exited. */ }
      };
      const stop = (reason: unknown) => {
        if (stopReason) return;
        stopReason = reason;
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), 1000);
      };
      const timeout = setTimeout(() => stop(new Error("Codex model timed out")), this.options.timeoutMs ?? 300_000);
      const abort = () => stop(request.signal?.reason ?? new Error("Codex model aborted"));
      request.signal?.addEventListener("abort", abort, { once: true });
      if (request.signal?.aborted) abort();
      child.stdin.on("error", () => { /* Process exit is handled below. */ });
      child.stdout.on("data", chunk => { output += String(chunk); });
      child.stderr.on("data", chunk => { error += String(chunk); });
      child.once("error", cause => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        request.signal?.removeEventListener("abort", abort);
        reject(cause);
      });
      child.once("close", code => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        request.signal?.removeEventListener("abort", abort);
        if (stopReason) return reject(stopReason);
        if (request.signal?.aborted) return reject(request.signal.reason ?? new Error("Codex Judge aborted"));
        if (code !== 0) return reject(new Error(error.trim() || `Codex Judge exited with code ${code}`));
        resolve({ output, error });
      });
      child.stdin.end(judgePrompt(request));
    });

    let parsed: ReturnType<typeof parseCodexJsonOutput>;
    try {
      parsed = parseCodexJsonOutput(result.output);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}${result.error ? `: ${result.error}` : ""}`);
    }
    return {
      content: parsed.content,
      modelId: request.model.modelId,
      usage: parsed.usage,
      metadata: { authMode: "codex-host", ephemeral: true },
    };
  }
}
