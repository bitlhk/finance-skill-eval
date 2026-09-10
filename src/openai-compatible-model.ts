import type {
  ModelAdapter,
  ModelCompletionRequest,
  ModelCompletionResponse,
} from "./adapters.js";

export type OpenAiCompatibleModelOptions = {
  adapterId?: string;
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  requestDefaults?: Record<string, unknown>;
};

/** Minimal OpenAI-compatible adapter for Analyzer or Judge roles. */
export class OpenAiCompatibleModelAdapter implements ModelAdapter {
  readonly adapterId: string;

  constructor(private readonly options: OpenAiCompatibleModelOptions) {
    this.adapterId = options.adapterId ?? "openai-compatible-model-v1";
  }

  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResponse> {
    const endpoint = completionEndpoint(this.options.baseUrl);
    const body: Record<string, unknown> = {
      ...this.options.requestDefaults,
      model: request.model.modelId,
      messages: request.messages,
      ...request.model.parameters,
    };
    if (request.responseFormat === "json") {
      body.response_format = { type: "json_object" };
    }
    const response = await fetch(endpoint, {
      method: "POST",
      signal: request.signal
        ? AbortSignal.any([
          request.signal,
          AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
        ])
        : AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
        ...this.options.headers,
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as {
      error?: { message?: string };
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Model request failed with HTTP ${response.status}`);
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("Model response has no message content");
    }
    return {
      content,
      modelId: payload.model ?? request.model.modelId,
      usage: payload.usage ? {
        inputTokens: payload.usage.prompt_tokens,
        outputTokens: payload.usage.completion_tokens,
        totalTokens: payload.usage.total_tokens,
      } : undefined,
    };
  }
}

function completionEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("baseUrl is required");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}
