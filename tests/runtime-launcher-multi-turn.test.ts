import {afterEach,expect,it,vi} from 'vitest';
import {evalCaseSchema} from '../src/contracts.js';
import {RuntimeLauncherAdapter} from '../src/runtime-launcher.js';
import {canonicalSha256} from '../src/shared/json-canonicalization.js';
afterEach(()=>vi.unstubAllGlobals());

it.each(['valid','unsupported','missing','query','output-digest','combined-output','tools','turn-count','missing-call','extra-call','duplicate-receipt','repeated-call','failed-prefix'] as const)('requires actual multi-turn receipts: %s',async change=>{
 const model={providerId:'launcher',modelId:'model',parameters:{}},variant={mode:'without_target_skill' as const,skillId:'fixture'};
 const turns=[{query:'Find',requiredTools:['find']},{query:'Select',requiredTools:['select']}];
 const testCase=evalCaseSchema.parse({caseId:'case',name:'case',prompt:'Find then select',evaluationGoal:'Keep context',requiredTools:['find','select'],turns,rubric:[{criterionId:'context',label:'Context',description:'Keep context',dimension:'business_completeness',weight:1}]});
 const receipt={sessionId:'native-session',workspaceId:'workspace',turns:turns.map((t,i)=>({index:i,queryDigest:canonicalSha256(t.query),status:'completed',outputDigest:canonicalSha256(`answer-${i}`),output:`answer-${i}`,toolNames:[...t.requiredTools]}))};
 const metadata:Record<string,unknown>={instanceConfigurationDigest:'config',conversation:receipt,caseScopeId:'scope'};
 const output=receipt.turns.map((t,i)=>`Turn ${i+1}:\n${t.output}`).join('\n\n');
 if(change==='missing')delete metadata.conversation;if(change==='query')receipt.turns[0]!.queryDigest='wrong';if(change==='output-digest')receipt.turns[0]!.outputDigest='wrong';if(change==='tools')receipt.turns[1]!.toolNames=[];if(change==='turn-count')receipt.turns.pop();
 const toolCalls=turns.flatMap(turn=>turn.requiredTools.map(name=>({name,status:'completed'})));
 if(change==='missing-call')toolCalls.pop();if(change==='extra-call')toolCalls.push({name:'unreported',status:'completed'});if(change==='duplicate-receipt')receipt.turns[1]!.toolNames.push('select');
 if(change==='repeated-call'){toolCalls.push({name:'select',status:'completed'});receipt.turns[1]!.toolNames.push('select');}
 if(change==='failed-prefix')receipt.turns.pop();
 const evidence={runId:'run',side:'right',caseId:'case',status:change==='failed-prefix'?'failed':'completed',modelId:'model',skillVersion:null,output:change==='combined-output'?'fabricated':output,elapsedMs:1,toolCalls,loadedSkills:[],usage:null,runtimeIdentityVerified:true,streamCompleted:true,error:change==='failed-prefix'?'Failed after calling select':null,metadata};
 const posted:unknown[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:unknown,init?:RequestInit)=>{
  if(init?.method==='DELETE')return new Response(null,{status:204});
  if(String(url).endsWith('/v1/runtime-instances'))return Response.json({schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:'instance',status:'ready',executeEndpoint:'/v1/runtime-instances/instance/execute',expiresAt:'2030-01-01T00:00:00Z',error:null,configurationDigest:'config'});
  if(String(url).endsWith('/v1/runtime-capabilities'))return Response.json({schemaVersion:'finance.skill-eval.runtime-capabilities.v1',runtime:{type:'openjiuwen',version:'test'},models:[{modelId:'model',upstreamModelId:'real'}],defaultModelId:'model',features:{streaming:true,asyncLaunch:true,packagedMcp:true,externalMcp:true,inlineSecrets:true,multiTurn:change!=='unsupported'},limits:{maxArchiveBytes:100,maxFiles:10,maxTimeoutMs:10000,maxConcurrentInstances:2}});
  posted.push(JSON.parse(String(init?.body)));return Response.json(evidence);
 }));
 const runtime=new RuntimeLauncherAdapter({baseUrl:'http://127.0.0.1:19999/',side:'right',model,variant,skill:null,environment:{environmentId:'env'},timeoutMs:10000});
 await runtime.prepare({runId:'run'});const execution=runtime.execute({runId:'run',side:'right',evalCase:testCase,model,variant});
 if(['valid','repeated-call','failed-prefix'].includes(change)){expect((await execution).status).toBe(evidence.status);expect(posted[0]).toMatchObject({turns});}else await expect(execution).rejects.toThrow();
 if(change==='unsupported')expect(posted).toEqual([]);await runtime.cleanup();
});
