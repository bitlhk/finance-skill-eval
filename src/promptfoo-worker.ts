import {
  evaluate,
  type ApiProvider,
  type CallApiContextParams,
  type ProviderResponse,
} from "promptfoo";

type EvaluationSide = "left" | "right";

type StartMessage = {
  type: "start";
  description: string;
  cases: Array<{ caseId: string; name: string; prompt: string }>;
  timeoutMs: number;
};

type ExecutionResultMessage = {
  type: "executionResult";
  requestId: string;
  output: string;
};

const pending = new Map<string, {
  resolve: (value: ProviderResponse) => void;
  reject: (error: Error) => void;
}>();

function send(message: Record<string, unknown>): void {
  if (!process.send) throw new Error("Promptfoo worker requires an IPC channel");
  process.send(message);
}

class IpcRuntimeProvider implements ApiProvider {
  constructor(private readonly side: EvaluationSide) {}

  id(): string {
    return `finance-skill-eval:${this.side}`;
  }

  async callApi(
    _prompt: string,
    context?: CallApiContextParams,
  ): Promise<ProviderResponse> {
    const caseId = String(context?.vars?.caseId ?? "");
    const requestId = `${this.side}:${caseId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const result = new Promise<ProviderResponse>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
    });
    send({ type: "execute", requestId, side: this.side, caseId });
    return result;
  }
}

async function run(message: StartMessage): Promise<void> {
  await evaluate(
    {
      description: message.description,
      prompts: ["{{prompt}}"],
      providers: (["left", "right"] as const).map(side => new IpcRuntimeProvider(side)),
      tests: message.cases.map(evalCase => ({
        description: `${evalCase.caseId} ${evalCase.name}`,
        vars: { caseId: evalCase.caseId, prompt: evalCase.prompt },
      })),
      writeLatestResults: false,
    },
    {
      cache: false,
      generateSuggestions: false,
      maxConcurrency: 2,
      showProgressBar: false,
      silent: true,
      timeoutMs: message.timeoutMs,
    },
  );
}

let started = false;
process.on("message", raw => {
  const message = raw as StartMessage | ExecutionResultMessage;
  if (message.type === "executionResult") {
    const deferred = pending.get(message.requestId);
    if (!deferred) return;
    pending.delete(message.requestId);
    deferred.resolve({ output: message.output });
    return;
  }
  if (message.type !== "start" || started) return;
  started = true;
  void run(message)
    .then(() => send({ type: "completed" }))
    .catch(error => send({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    }));
});

process.on("disconnect", () => {
  for (const deferred of pending.values()) {
    deferred.reject(new Error("Promptfoo worker parent disconnected"));
  }
  pending.clear();
  process.exit(0);
});
