import {afterEach,describe,expect,it,vi} from 'vitest';
import {evalCaseSchema,workspaceFilesDigest} from '../src/contracts.js';
import {RuntimeLauncherAdapter,launcherGenerationSchema} from '../src/runtime-launcher.js';

afterEach(()=>vi.unstubAllGlobals());

const digest='a'.repeat(64),configurationDigest='configuration-digest';
const evalCase=evalCaseSchema.parse({caseId:'case-1',name:'case',prompt:'query',evaluationGoal:'goal',requiredTools:['lookup'],workspaceFiles:[{path:'fixtures/input.json',content:'{"account":"A1"}'}],rubric:[{criterionId:'one',label:'one',description:'one',dimension:'professional_fit',weight:1}]});
const variant={mode:'skill_version' as const,skillId:'demo',version:'1',artifactSha256:digest};

describe('Runtime Launcher adapter',()=>{
  it.each(['runId','caseId','side','instanceId'])('rejects a failure observation with another %s before forwarding it',async(field)=>{
    const state={schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:'instance-1',status:'ready',executeEndpoint:'/v1/runtime-instances/instance-1/execute',expiresAt:'2030-01-01T00:00:00.000Z',error:null,configurationDigest};
    const event={schemaVersion:'finance.runtime-observation.v1',eventId:'failure-1',sequence:1,occurredAt:'2026-10-01T00:00:00.000Z',traceId:'trace-1',instanceId:'instance-1',runId:'run-1',caseId:'case-1',side:'right',source:{adapter:'launcher',synthesized:true},kind:'execution.failed',payload:{error:{code:'EVAL_TOOL_EXECUTION_FAILED',message:'private',retryable:false}},[field]:field==='side'?'left':'another'};
    vi.stubGlobal('fetch',async(input:unknown,init:RequestInit)=>init.method==='DELETE'?new Response(null,{status:204}):String(input).endsWith('/execute')?new Response(`data: ${JSON.stringify(event)}\n\n`,{headers:{'content-type':'text/event-stream'}}):Response.json(state));
    const model={providerId:'managed',modelId:'execution',parameters:{}},onEvent=vi.fn();
    const runtime=new RuntimeLauncherAdapter({baseUrl:'http://127.0.0.1:9000/',side:'right',model,variant,skill:null,environment:{environmentId:'test'},timeoutMs:300000});
    await runtime.prepare({runId:'run-1'});
    try{await expect(runtime.execute({runId:'run-1',side:'right',evalCase,model,variant,onEvent})).rejects.toThrow('does not match');expect(onEvent).not.toHaveBeenCalled();}
    finally{await runtime.cleanup();}
  });
  it('keeps safe failure correlation without verifying execution or forwarding private native fields',async()=>{
    const state={schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:'instance-1',status:'ready',executeEndpoint:'/v1/runtime-instances/instance-1/execute',expiresAt:'2030-01-01T00:00:00.000Z',error:null,configurationDigest};
    const event={schemaVersion:'finance.runtime-observation.v1',eventId:'failure-1',sequence:1,occurredAt:'2026-10-01T00:00:00.000Z',traceId:'trace-1',instanceId:'instance-1',runId:'run-1',caseId:'case-1',side:'right',source:{adapter:'finance-solution-builder',synthesized:true,nativeEventType:'builder.execution-correlation.v1'},kind:'execution.failed',payload:{error:{code:'EVAL_TOOL_EXECUTION_FAILED',message:'private upstream detail',retryable:false}},native:{data:{basis:'LAUNCHER_CORRELATION_NOT_EXECUTION_VERIFICATION',buildId:'agent-test',hostRunId:'eval-test',hostTraceId:'/private/key',unrelated:'canary'}}};
    vi.stubGlobal('fetch',async(input:unknown,init:RequestInit)=>{
      if(init.method==='DELETE')return new Response(null,{status:204});
      return String(input).endsWith('/execute')?new Response(`data: ${JSON.stringify(event)}\n\n`,{headers:{'content-type':'text/event-stream'}}):Response.json(state);
    });
    const model={providerId:'managed',modelId:'execution',parameters:{}};
    const runtime=new RuntimeLauncherAdapter({baseUrl:'http://127.0.0.1:9000/',side:'right',model,variant,skill:null,environment:{environmentId:'test'},timeoutMs:300000});
    await runtime.prepare({runId:'run-1'});
    try{
      await expect(runtime.execute({runId:'run-1',side:'right',evalCase,model,variant})).rejects.toMatchObject({
        name:'RuntimeExecutionFailure',metadata:{launcherDiagnostics:{basis:'LAUNCHER_CORRELATION_NOT_EXECUTION_VERIFICATION',buildId:'agent-test',hostRunId:'eval-test'},instanceId:'instance-1',launcherTraceId:'trace-1'}});
    }finally{await runtime.cleanup();}
  });
  it('preserves a normalized execution failure and still reclaims the instance',async()=>{
    const deleted=vi.fn(),executed=vi.fn();
    const state={schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:'instance-1',status:'ready',executeEndpoint:'/v1/runtime-instances/instance-1/execute',expiresAt:'2030-01-01T00:00:00.000Z',error:null,configurationDigest};
    const event={schemaVersion:'finance.runtime-observation.v1',eventId:'failure-1',sequence:1,occurredAt:'2026-10-01T00:00:00.000Z',traceId:'trace-1',instanceId:'instance-1',runId:'run-1',caseId:'case-1',side:'right',source:{adapter:'launcher',synthesized:true},kind:'execution.failed',payload:{error:{code:'RUNTIME_EVIDENCE_UNVERIFIED',message:'private upstream detail',retryable:false}}};
    vi.stubGlobal('fetch',async(input:unknown,init:RequestInit)=>{
      if(init.method==='DELETE'){deleted();return new Response(null,{status:204})}
      if(String(input).endsWith('/execute')){executed();return new Response(`data: ${JSON.stringify(event)}\n\n`,{headers:{'content-type':'text/event-stream'}})}
      return Response.json(state);
    });
    const model={providerId:'managed',modelId:'execution',parameters:{}};
    const runtime=new RuntimeLauncherAdapter({baseUrl:'http://127.0.0.1:9000/',side:'right',model,variant,skill:null,environment:{environmentId:'test'},timeoutMs:300000});
    await runtime.prepare({runId:'run-1'});
    try{
      const first=runtime.execute({runId:'run-1',side:'right',evalCase,model,variant});
      const queued=runtime.execute({runId:'run-1',side:'right',evalCase:{...evalCase,caseId:'case-2'},model,variant});
      await expect(first).rejects.toThrow('Runtime execution failed: RUNTIME_EVIDENCE_UNVERIFIED');
      await expect(queued).rejects.toMatchObject({name:'RuntimeCaseNotExecutedError',failedCaseId:'case-1'});
      expect(executed).toHaveBeenCalledOnce();
    }
    finally{await runtime.cleanup()}
    expect(deleted).toHaveBeenCalledOnce();
  });
  it('validates a complete generation contract without accepting unsupported options',()=>{
    const valid={schemaVersion:'finance.eval-generation.v1',temperature:0.25,top_p:0.8,max_tokens:1234};
    expect(launcherGenerationSchema.parse(valid)).toEqual(valid);
    for(const change of [{temperature:NaN},{temperature:3},{top_p:0},{top_p:Infinity},{max_tokens:0},{max_tokens:1.5},{seed:42}])
      expect(()=>launcherGenerationSchema.parse({...valid,...change})).toThrow();
    expect(()=>launcherGenerationSchema.parse({schemaVersion:valid.schemaVersion,temperature:0.25})).toThrow();
  });
  it.each([{}, {temperature:0.25,top_p:0.8,max_tokens:1234}])('creates one configured instance, consumes its stream and always deletes it: %j',async(parameters)=>{
    const calls:Array<{url:string;init:RequestInit|undefined}>=[];
    const state={schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:'instance-1',status:'ready',executeEndpoint:'/v1/runtime-instances/instance-1/execute',expiresAt:'2030-01-01T00:00:00.000Z',error:null,configurationDigest};
    const evidence={runId:'run-1',side:'right',caseId:'case-1',status:'completed',modelId:'execution',skillVersion:'1',output:'done',elapsedMs:1,toolCalls:[{name:'lookup',status:'completed'}],loadedSkills:[{skillId:'demo',version:'1'}],usage:null,runtimeIdentityVerified:true,streamCompleted:true,error:null,metadata:{skillArtifactSha256:digest,instanceConfigurationDigest:configurationDigest,workspaceFilesDigest:workspaceFilesDigest(evalCase.workspaceFiles!)}};
    Object.assign(evidence.metadata,Object.keys(parameters).length?{declaredModelParameters:parameters,modelGenerationHostVerified:true}:{});
    vi.stubGlobal('fetch',vi.fn(async(input:URL|string|Request,init?:RequestInit)=>{
      const url=String(input);calls.push({url,init});
      if(init?.method==='POST'&&url.endsWith('/v1/runtime-instances'))return Response.json(state);
      if(init?.method==='POST'&&url.endsWith('/execute'))return new Response(`data: ${JSON.stringify({type:'text_delta',text:'done'})}\n\ndata: ${JSON.stringify({evidence})}\n\n`,{headers:{'content-type':'text/event-stream'}});
      if(init?.method==='DELETE')return new Response(null,{status:204});
      throw new Error(`Unexpected request ${url}`);
    }));
    const events:unknown[]=[];
    const runtime=new RuntimeLauncherAdapter({baseUrl:'http://127.0.0.1:9000/',side:'right',model:{providerId:'ui-only',modelId:'execution',parameters},variant,
      skill:{skillId:'demo',version:'1',artifactSha256:digest,instructions:'Use lookup.',files:{'mcp/server.py':'pass'},archiveBase64:'YXJjaGl2ZQ==',archiveSha256:'b'.repeat(64)},
      environment:{environmentId:'launcher',mcpServers:[{serverId:'external',endpoint:'https://example.com/mcp',transport:'streamable_http',toolNames:['lookup'],secretHeaders:{authorization:'Bearer external-secret'}}],candidateMcpServices:[{assetDigest:digest,toolNames:['lookup'],filePaths:['mcp/server.py'],start:['python','mcp/server.py'],secretEnvironment:{API_TOKEN:'top-secret'}}],
        runtimeToolConfig:{context:{user:{type:'string',value:'alice',sensitive:true}},providers:{},tools:{}}},timeoutMs:300000});
    await runtime.prepare!({runId:'run-1'});
    expect((await runtime.execute({runId:'run-1',side:'right',evalCase,model:{providerId:'ui-only',modelId:'execution',parameters:{}},variant,onEvent:event=>events.push(event)})).output).toBe('done');
    await runtime.cleanup!();
    const createBody=JSON.parse(String(calls[0]!.init!.body));
    if(Object.keys(parameters).length)expect(createBody.generation).toEqual({schemaVersion:'finance.eval-generation.v1',temperature:0.25,top_p:0.8,max_tokens:1234});
    else expect(createBody).not.toHaveProperty('generation');
    expect(createBody.environment.candidateMcpServices[0]).not.toHaveProperty('secretEnvironment');
    expect(createBody.environment.candidateMcpServices[0].secretBindings).toEqual({API_TOKEN:'mcp.0.API_TOKEN'});
    expect(createBody.environment.mcpServers[0]).not.toHaveProperty('secretHeaders');
    expect(createBody.environment.mcpServers[0].secretBindings).toEqual({authorization:'external-mcp.0.authorization'});
    expect(createBody.environment.runtimeToolConfig.context.user.value).toEqual({$secret:'context.user'});
    expect(createBody.secrets.values).toEqual({'external-mcp.0.authorization':'Bearer external-secret','mcp.0.API_TOKEN':'top-secret','context.user':'alice'});
    const executeBody=JSON.parse(String(calls.find(call=>call.url.endsWith('/execute'))!.init!.body));
    expect(executeBody.workspaceFiles).toEqual(evalCase.workspaceFiles);
    expect(events).toEqual([expect.objectContaining({type:'text_delta',text:'done'})]);
    expect(calls.at(-1)).toMatchObject({url:'http://127.0.0.1:9000/v1/runtime-instances/instance-1',init:{method:'DELETE'}});
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
    expect(calls.at(-1)!.init!.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([{temperature:0.25},{temperature:0.25,top_p:0.8,max_tokens:1234,seed:42},
    {temperature:0.25,top_p:0.8,max_tokens:1234,schemaVersion:'ignored'}])('rejects incomplete or unknown parameters before creating an instance: %j',async(parameters)=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    const runtime=new RuntimeLauncherAdapter({baseUrl:'http://127.0.0.1:9000/',side:'right',model:{providerId:'managed',modelId:'execution',parameters},variant,skill:null,environment:{environmentId:'test'},timeoutMs:300000});
    await expect(runtime.prepare({runId:'run-1'})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
