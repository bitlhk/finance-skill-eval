import type {
  ModelAdapter,
  ModelCompletionRequest,
  ModelCompletionResponse,
} from "./adapters.js";
import {Agent} from 'undici';

export type OpenAiCompatibleModelOptions = {
  adapterId?: string;
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  requestDefaults?: Record<string, unknown>;
};

export class ModelCompletionError extends Error{
  constructor(readonly code:'MODEL_HTTP_ERROR'|'MODEL_OUTPUT_TRUNCATED'|'MODEL_EMPTY_RESPONSE',message:string,readonly httpStatus?:number){super(message);this.name='ModelCompletionError';}
}

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
    if(request.toolFree)for(const key of ['tools','tool_choice','functions','function_call','parallel_tool_calls'])delete body[key];
    if (request.responseFormat === "json") {
      body.response_format = { type: "json_object" };
    }
    const timeoutMs=this.options.timeoutMs??180_000;
    // Undici otherwise imposes a hidden 300s response-header timeout even when
    // the Analyzer's explicit deadline is longer. Own and close this request pool.
    const dispatcher=new Agent({headersTimeout:timeoutMs,bodyTimeout:timeoutMs});
    try{
    const init={
      method: "POST",
      dispatcher,
      signal: request.signal
        ? AbortSignal.any([
          request.signal,
          AbortSignal.timeout(timeoutMs),
        ])
        : AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
        ...this.options.headers,
      },
      body: JSON.stringify(body),
    };
    const response = await fetch(endpoint, init);
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelCompletionError('MODEL_HTTP_ERROR',`模型服务请求失败（HTTP ${response.status}）`,response.status);
    }
    const payload = await response.json() as {
      error?: { message?: string };
      choices?: Array<{ message?: { content?: string };finish_reason?:string }>;
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    if(payload.choices?.[0]?.finish_reason==='length')throw new ModelCompletionError('MODEL_OUTPUT_TRUNCATED','模型输出达到长度上限，未形成完整结果；请检查模型输出预算');
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new ModelCompletionError('MODEL_EMPTY_RESPONSE','模型没有返回最终答案');
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
    }finally{await dispatcher.close();}
  }
}

function completionEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("baseUrl is required");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}
