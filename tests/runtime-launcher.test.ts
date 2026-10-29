import {standardSkills,standardMetadata,standardCapabilities,released} from './runtime-standard-fixture.js';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {evalCaseSchema,workspaceFilesDigest} from '../src/contracts.js';
import {RuntimeLauncherAdapter,launcherGenerationSchema} from '../src/runtime-launcher.js';

afterEach(()=>vi.unstubAllGlobals());

const digest='a'.repeat(64),configurationDigest='configuration-digest';
const evalCase=evalCaseSchema.parse({caseId:'case-1',name:'case',prompt:'query',evaluationGoal:'goal',requiredTools:['lookup'],workspaceFiles:[{path:'fixtures/input.json',content:'{"account":"A1"}'}],rubric:[{criterionId:'one',label:'one',description:'one',dimension:'professional_fit',weight:1}]});
const variant={mode:'skill_version' as const,skillId:'demo',version:'1',artifactSha256:digest};

describe('Runtime Launcher adapter',()=>{
  it('retains failure and skips subsequent cases only in the controlled comparison mode',async()=>{
    let executions=0,deletions=0;
    vi.stubGlobal('fetch',vi.fn(async(_input:unknown,init?:RequestInit)=>{
      if(String(_input).endsWith('/v1/runtime-capabilities'))return Response.json(standardCapabilities('execution'));
      if(init?.method==='DELETE'){
        deletions++;
        return Response.json({cleanup:{schemaVersion:'finance.eval-cleanup-observation.v1',instanceId:'instance-1',
          observedAt:'2026-10-09T00:00:00Z',status:deletions===1?'PENDING':'RELEASED',buildId:'owned-build',scope:'THIS_INSTANCE',error:'PRIVATE_CLEANUP_DETAIL'}});
      }
      if(String(_input).endsWith('/v1/runtime-instances'))return Response.json({schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:'instance-1',status:'ready',executeEndpoint:'/v1/runtime-instances/instance-1/execute',expiresAt:'2030-01-01T00:00:00Z',error:null,configurationDigest});
      executions++;return Response.json({error:'FIRST_CASE_FAILURE'},{status:502});
    }));
    const model={providerId:'managed',modelId:'execution',parameters:{}};
    const runtime=new RuntimeLauncherAdapter({baseUrl:'http://127.0.0.1:9000/',side:'right',model,variant,skill:null,skillSet:standardSkills,environment:{environmentId:'test'},timeoutMs:1000,stopAfterFailure:true});
    await runtime.prepare({runId:'run-1'});
    const request=(caseId:string)=>({runId:'run-1',side:'right' as const,evalCase:{...evalCase,caseId},model,variant});
    await expect(runtime.execute(request('first'))).rejects.toThrow('FIRST_CASE_FAILURE');
    await expect(runtime.execute(request('next'))).rejects.toThrow('本题未执行');
    expect(executions).toBe(1);
    await runtime.cleanup();expect(deletions).toBe(2);
    expect(runtime.finalizationEvidence()).toMatchObject({status:'RELEASED',instanceId:'instance-1',buildId:'owned-build'});
    expect(JSON.stringify(runtime.finalizationEvidence())).not.toContain('PRIVATE_CLEANUP_DETAIL');
  });
  it.each([false,true])('recreates only for the next case, including queued executions; cleanup failure fails closed: %s',async(cleanupFails)=>{
    let created=0;const keys:string[]=[],executed:string[]=[],deleted:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(input:URL|string|Request,init?:RequestInit)=>{
      const url=String(input);
      if(url.endsWith('/v1/runtime-capabilities'))return Response.json(standardCapabilities('execution'));
      if(init?.method==='POST'&&url.endsWith('/v1/runtime-instances')){
        created+=1;keys.push((init.headers as Record<string,string>)['idempotency-key']!);
        return Response.json({schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:`instance-${created}`,status:'ready',executeEndpoint:`/v1/runtime-instances/instance-${created}/execute`,expiresAt:'2030-01-01T00:00:00.000Z',error:null,configurationDigest});
      }
      if(init?.method==='DELETE'){
        deleted.push(url);return cleanupFails?Response.json({error:'cleanup_failed'},{status:503}):Response.json(released(url.split('/').at(-1)!));
      }
      executed.push(`${url}:${JSON.parse(String(init?.body)).caseId}`);
      return Response.json({error:'EVAL_PACKAGE_ITERATION_LIMIT'},{status:502});
    }));
    const runtime=new RuntimeLauncherAdapter({baseUrl:'http://127.0.0.1:9000/',side:'right',model:{providerId:'managed',modelId:'execution',parameters:{}},variant,skill:null,skillSet:standardSkills,environment:{environmentId:'test'},timeoutMs:1000});
    await runtime.prepare({runId:'run-1'});
    const execute=(caseId:string)=>runtime.execute({runId:'run-1',side:'right',evalCase:{...evalCase,caseId},model:{providerId:'managed',modelId:'execution',parameters:{}},variant});
    const results=await Promise.allSettled([execute('first'),execute('second')]);
    expect(results.map(result=>result.status)).toEqual(['rejected','rejected']);
    expect(String((results[0] as PromiseRejectedResult).reason)).toContain('EVAL_PACKAGE_ITERATION_LIMIT');
    expect(executed[0]).toContain('instance-1/execute:first');
    expect(created).toBe(cleanupFails?1:2);
    expect(executed).toHaveLength(cleanupFails?1:2);
    if(!cleanupFails){expect(keys[0]).not.toBe(keys[1]);expect(executed[1]).toContain('instance-2/execute:second');}
    else{
      expect(String((results[1] as PromiseRejectedResult).reason)).toContain('cleanup_failed');
      await expect(runtime.cleanup()).rejects.toThrow('cleanup_failed');
      expect(deleted).toHaveLength(2); // Retain the handle so shutdown can retry deletion.
    }
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
    const evidence={runId:'run-1',side:'right',caseId:'case-1',status:'completed',modelId:'execution',skillVersion:'1',output:'done',elapsedMs:1,toolCalls:[{name:'lookup',status:'completed'}],loadedSkills:standardSkills.skills.map(({skillId,version})=>({skillId,version})),usage:null,runtimeIdentityVerified:true,streamCompleted:true,error:null,metadata:{...standardMetadata,instanceConfigurationDigest:configurationDigest,workspaceFilesDigest:workspaceFilesDigest(evalCase.workspaceFiles!)}};
    Object.assign(evidence.metadata,Object.keys(parameters).length?{declaredModelParameters:parameters,modelGenerationHostVerified:true}:{});
    vi.stubGlobal('fetch',vi.fn(async(input:URL|string|Request,init?:RequestInit)=>{
      const url=String(input);
      if(url.endsWith('/v1/runtime-capabilities'))return Response.json(standardCapabilities('execution'));calls.push({url,init});
      if(init?.method==='POST'&&url.endsWith('/v1/runtime-instances'))return Response.json(state);
      if(init?.method==='POST'&&url.endsWith('/execute'))return new Response(`data: ${JSON.stringify({type:'text_delta',text:'done'})}\n\ndata: ${JSON.stringify({evidence})}\n\n`,{headers:{'content-type':'text/event-stream'}});
      if(init?.method==='DELETE')return Response.json(released('instance-1'));
      throw new Error(`Unexpected request ${url}`);
    }));
    const events:unknown[]=[];
    const runtime=new RuntimeLauncherAdapter({baseUrl:'http://127.0.0.1:9000/',side:'right',model:{providerId:'ui-only',modelId:'execution',parameters},variant,
      skill:null,skillSet:standardSkills,
      environment:{environmentId:'launcher',mcpServers:[{serverId:'external',endpoint:'https://example.com/mcp',transport:'streamable_http',toolNames:['lookup'],secretHeaders:{authorization:'Bearer external-secret'}}],candidateMcpServices:[{assetDigest:digest,toolNames:['lookup'],filePaths:['mcp/server.py'],start:['python','mcp/server.py'],secretEnvironment:{API_TOKEN:'top-secret'}}],
        runtimeToolConfig:{context:{user:{type:'string',value:'alice',sensitive:true}},providers:{},tools:{}}},timeoutMs:300000});
    await runtime.prepare!({runId:'run-1'});
    expect((await runtime.execute({runId:'run-1',side:'right',evalCase,model:{providerId:'ui-only',modelId:'execution',parameters:{}},variant,onEvent:event=>events.push(event)})).output).toBe('done');
    await runtime.cleanup!();
    const createBody=JSON.parse(String(calls.find(c=>c.url.endsWith('/v1/runtime-instances'))!.init!.body));
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
    const runtime=new RuntimeLauncherAdapter({baseUrl:'http://127.0.0.1:9000/',side:'right',model:{providerId:'managed',modelId:'execution',parameters},variant,skill:null,skillSet:standardSkills,environment:{environmentId:'test'},timeoutMs:300000});
    await expect(runtime.prepare({runId:'run-1'})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
