import {afterEach,describe,expect,it,vi} from 'vitest';
import {evalCaseSchema,workspaceFilesDigest} from '../src/contracts.js';
import {RuntimeLauncherAdapter} from '../src/runtime-launcher.js';

afterEach(()=>vi.unstubAllGlobals());

const digest='a'.repeat(64),configurationDigest='configuration-digest';
const evalCase=evalCaseSchema.parse({caseId:'case-1',name:'case',prompt:'query',evaluationGoal:'goal',requiredTools:['lookup'],workspaceFiles:[{path:'fixtures/input.json',content:'{"account":"A1"}'}],rubric:[{criterionId:'one',label:'one',description:'one',dimension:'professional_fit',weight:1}]});
const variant={mode:'skill_version' as const,skillId:'demo',version:'1',artifactSha256:digest};

describe('Runtime Launcher adapter',()=>{
  it('creates one configured instance, consumes its stream and always deletes it',async()=>{
    const calls:Array<{url:string;init:RequestInit|undefined}>=[];
    const state={schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:'instance-1',status:'ready',executeEndpoint:'/v1/runtime-instances/instance-1/execute',expiresAt:'2030-01-01T00:00:00.000Z',error:null,configurationDigest};
    const evidence={runId:'run-1',side:'right',caseId:'case-1',status:'completed',modelId:'execution',skillVersion:'1',output:'done',elapsedMs:1,toolCalls:[{name:'lookup',status:'completed'}],loadedSkills:[{skillId:'demo',version:'1'}],usage:null,runtimeIdentityVerified:true,streamCompleted:true,error:null,metadata:{skillArtifactSha256:digest,instanceConfigurationDigest:configurationDigest,workspaceFilesDigest:workspaceFilesDigest(evalCase.workspaceFiles!)}};
    vi.stubGlobal('fetch',vi.fn(async(input:URL|string|Request,init?:RequestInit)=>{
      const url=String(input);calls.push({url,init});
      if(init?.method==='POST'&&url.endsWith('/v1/runtime-instances'))return Response.json(state);
      if(init?.method==='POST'&&url.endsWith('/execute'))return new Response(`data: ${JSON.stringify({type:'text_delta',text:'done'})}\n\ndata: ${JSON.stringify({evidence})}\n\n`,{headers:{'content-type':'text/event-stream'}});
      if(init?.method==='DELETE')return new Response(null,{status:204});
      throw new Error(`Unexpected request ${url}`);
    }));
    const events:unknown[]=[];
    const runtime=new RuntimeLauncherAdapter({baseUrl:'http://127.0.0.1:9000/',side:'right',model:{providerId:'ui-only',modelId:'execution',parameters:{}},variant,
      skill:{skillId:'demo',version:'1',artifactSha256:digest,instructions:'Use lookup.',files:{'mcp/server.py':'pass'},archiveBase64:'YXJjaGl2ZQ==',archiveSha256:'b'.repeat(64)},
      environment:{environmentId:'launcher',mcpServers:[{serverId:'external',endpoint:'https://example.com/mcp',transport:'streamable_http',toolNames:['lookup'],secretHeaders:{authorization:'Bearer external-secret'}}],candidateMcpServices:[{assetDigest:digest,toolNames:['lookup'],filePaths:['mcp/server.py'],start:['python','mcp/server.py'],secretEnvironment:{API_TOKEN:'top-secret'}}],
        runtimeToolConfig:{context:{user:{type:'string',value:'alice',sensitive:true}},providers:{},tools:{}}},timeoutMs:300000});
    await runtime.prepare!({runId:'run-1'});
    expect((await runtime.execute({runId:'run-1',side:'right',evalCase,model:{providerId:'ui-only',modelId:'execution',parameters:{}},variant,onEvent:event=>events.push(event)})).output).toBe('done');
    await runtime.cleanup!();
    const createBody=JSON.parse(String(calls[0]!.init!.body));
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
});
