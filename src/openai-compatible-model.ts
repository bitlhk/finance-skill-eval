import type {
  ModelAdapter,
  ModelCompletionRequest,
  ModelCompletionResponse,
} from "./adapters.js";
import {Agent, EnvHttpProxyAgent} from 'undici';

export type OpenAiCompatibleModelOptions = {
  adapterId?: string;
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  requestDefaults?: Record<string, unknown>;
};

export class ModelCompletionError extends Error{
  constructor(readonly code:'MODEL_HTTP_ERROR'|'MODEL_OUTPUT_TRUNCATED'|'MODEL_EMPTY_RESPONSE'|'MODEL_NETWORK_ERROR',message:string,readonly httpStatus?:number){super(message);this.name='ModelCompletionError';}
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
    // The connector also defaults to a hidden 10s deadline. All HTTP phases must
    // obey the explicit request deadline, including TCP/TLS establishment.
    const options={connect:{timeout:timeoutMs},headersTimeout:timeoutMs,bodyTimeout:timeoutMs};
    // A per-request dispatcher overrides Node's global proxy setting. Honor the
    // service's explicit proxy configuration while retaining deadline ownership.
    const proxied=process.env.HTTPS_PROXY||process.env.https_proxy||process.env.HTTP_PROXY||process.env.http_proxy;
    const dispatcher=proxied ? new EnvHttpProxyAgent({...options,proxyTls:{timeout:timeoutMs},requestTls:{timeout:timeoutMs}}) : new Agent(options);
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
    if(payload.choices?.[0]?.finish_reason==='length'){
      // Report numeric usage only, never provider output, reasoning or secrets.
      const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;
      const used=count(payload.usage?.completion_tokens);
      const limit=count(body.max_completion_tokens)??count(body.max_tokens);
      const details=[used!==undefined?`已用输出 token：${used}`:undefined,
        limit!==undefined?`请求输出上限：${limit}`:'请求未显式配置输出上限'].filter(Boolean).join('；');
      throw new ModelCompletionError('MODEL_OUTPUT_TRUNCATED',`模型输出达到长度上限，未形成完整结果（${details}）；请检查模型输出预算`);
    }
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
    }catch(error){
      if(error instanceof TypeError){
        const code=(error.cause as {code?:unknown}|undefined)?.code;
        const labels:Record<string,string>={UND_ERR_CONNECT_TIMEOUT:'连接模型服务超时',UND_ERR_HEADERS_TIMEOUT:'等待模型响应超时',
          UND_ERR_BODY_TIMEOUT:'读取模型响应超时',UND_ERR_SOCKET:'模型服务连接中断',ECONNRESET:'模型服务连接中断',
          ECONNREFUSED:'无法连接模型服务',ENOTFOUND:'无法解析模型服务地址',EAI_AGAIN:'暂时无法解析模型服务地址'};
        if(typeof code==='string'&&Object.hasOwn(labels,code))throw new ModelCompletionError('MODEL_NETWORK_ERROR',labels[code]!);
        if(error.message==='fetch failed')throw new ModelCompletionError('MODEL_NETWORK_ERROR','模型服务网络请求失败，请检查连接');
      }
      throw error;
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
