import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleModelAdapter } from "../src/index.js";
import {createServer} from 'node:http';
const agentOptions=vi.hoisted(()=>vi.fn());
vi.mock('undici',async importOriginal=>{
  const original=await importOriginal<typeof import('undici')>();
  return {...original,Agent:class extends original.Agent{constructor(options:ConstructorParameters<typeof original.Agent>[0]){super(options);agentOptions(options);}}};
});

afterEach(() => {
  vi.unstubAllGlobals();
  agentOptions.mockClear();
});

describe("OpenAiCompatibleModelAdapter", () => {
  it('uses one explicit deadline for connection, headers and body without hidden retries',async()=>{
    const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:'ok'}}]})));
    vi.stubGlobal('fetch',fetchMock);
    const adapter=new OpenAiCompatibleModelAdapter({apiKey:'private',baseUrl:'https://models.example/v1',timeoutMs:120000});
    await adapter.complete({requestId:'deadline-phases',model:{providerId:'test',modelId:'test',parameters:{}},messages:[]});
    expect(agentOptions).toHaveBeenCalledWith({connect:{timeout:120000},headersTimeout:120000,bodyTimeout:120000});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(['UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','ECONNRESET','ENOTFOUND','PRIVATE_CAUSE','constructor'])('reports safe network failures: %s',code=>{
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new TypeError('fetch failed',{cause:{code,detail:'PRIVATE_KEY https://private.host/'}})));
    const adapter=new OpenAiCompatibleModelAdapter({apiKey:'private',baseUrl:'https://models.example/v1'});
    return expect(adapter.complete({requestId:'network',model:{providerId:'test',modelId:'test',parameters:{}},messages:[]})).rejects.toMatchObject({code:'MODEL_NETWORK_ERROR',message:expect.not.stringContaining('PRIVATE')});
  });
  it('uses the configured deadline for a slow real HTTP response and closes the pool',async()=>{
    const server=createServer((_req,res)=>{const timer=setTimeout(()=>res.end('{}'),2000);res.once('close',()=>clearTimeout(timer));});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=(server.address() as {port:number}).port;
    try{const adapter=new OpenAiCompatibleModelAdapter({apiKey:'unit',baseUrl:`http://127.0.0.1:${port}/v1`,timeoutMs:30});
      await expect(adapter.complete({requestId:'deadline',model:{providerId:'test',modelId:'test',parameters:{}},messages:[]})).rejects.toMatchObject({name:'TimeoutError'});
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('reports HTTP status safely even when a provider sends a non-JSON error page',()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('PRIVATE_PROVIDER_DETAIL',{status:503})));
    const adapter=new OpenAiCompatibleModelAdapter({apiKey:'private',baseUrl:'https://models.example/v1'});
    return expect(adapter.complete({requestId:'html-error',model:{providerId:'test',modelId:'test',parameters:{}},messages:[]})).rejects.toMatchObject({code:'MODEL_HTTP_ERROR',message:'模型服务请求失败（HTTP 503）'});
  });
  it.each(['','{"partial":'])('rejects truncated responses without exposing their content: %s',content=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content},finish_reason:'length'}]}),{status:200})));
    const adapter=new OpenAiCompatibleModelAdapter({apiKey:'private',baseUrl:'https://models.example/v1'});
    return expect(adapter.complete({requestId:'truncated',model:{providerId:'test',modelId:'test',parameters:{}},messages:[]})).rejects.toMatchObject({code:'MODEL_OUTPUT_TRUNCATED'});
  });
  it('does not expose provider error text or credentials',()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{message:'PRIVATE_KEY'}}),{status:401})));
    const adapter=new OpenAiCompatibleModelAdapter({apiKey:'private',baseUrl:'https://models.example/v1'});
    return expect(adapter.complete({requestId:'failed',model:{providerId:'test',modelId:'test',parameters:{}},messages:[]})).rejects.toMatchObject({code:'MODEL_HTTP_ERROR',message:'模型服务请求失败（HTTP 401）'});
  });
  it("maps an OpenAI-compatible JSON completion without exposing credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "judge-model",
      choices: [{ message: { content: "{\"winner\":\"A\"}" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OpenAiCompatibleModelAdapter({
      apiKey: "not-recorded",
      baseUrl: "https://models.example/v1/",
      requestDefaults: { thinking: { type: "disabled" }, temperature: 0.6, model: "not-an-override" },
    });

    const response = await adapter.complete({
      requestId: "judge-001",
      model: { providerId: "test", modelId: "judge-model", parameters: {} },
      messages: [{ role: "user", content: "compare" }],
      responseFormat: "json",
    });

    expect(response.content).toBe("{\"winner\":\"A\"}");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ model: "judge-model", thinking: { type: "disabled" }, temperature: 0.6 });
    expect(response.usage?.totalTokens).toBe(15);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://models.example/v1/chat/completions",
      expect.objectContaining({ method: "POST",dispatcher:expect.any(Object) }),
    );
  });
});
