import Fastify from 'fastify';
import {afterEach,expect,it} from 'vitest';
import {RuntimeLauncherAdapter,RUNTIME_LAUNCHER_STREAM_LIMITS} from '../src/runtime-launcher.js';

const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{while(cleanup.length)await cleanup.pop()!();});

async function launcher(mode:'oversized-frame'|'oversized-evidence'|'oversized-json-evidence'|'unfinished'){
  const app=Fastify();
  app.post('/v1/runtime-instances',()=>({schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:'instance',status:'ready',executeEndpoint:'/v1/runtime-instances/instance/execute',expiresAt:new Date(Date.now()+60_000).toISOString(),error:null,configurationDigest:'config'}));
  app.post('/v1/runtime-instances/instance/execute',(_request,reply)=>{
    if(mode==='oversized-json-evidence')return {output:'x'.repeat(RUNTIME_LAUNCHER_STREAM_LIMITS.evidenceBytes+1)};
    reply.hijack();reply.raw.writeHead(200,{'content-type':'text/event-stream'});
    if(mode==='oversized-frame')reply.raw.write(`data: ${'x'.repeat(RUNTIME_LAUNCHER_STREAM_LIMITS.frameBytes+1)}`);
    else if(mode==='unfinished')reply.raw.write('data: {"type":"status"}');
    else reply.raw.write(`data: ${JSON.stringify({evidence:{output:'x'.repeat(RUNTIME_LAUNCHER_STREAM_LIMITS.evidenceBytes+1)}})}\n\n`);
    reply.raw.end();
  });
  app.delete('/v1/runtime-instances/instance',(_request,reply)=>reply.code(204).send());
  await app.listen({host:'127.0.0.1',port:0});cleanup.push(()=>app.close());
  const address=app.server.address();if(!address||typeof address==='string')throw new Error('missing address');
  const adapter=new RuntimeLauncherAdapter({baseUrl:`http://127.0.0.1:${address.port}/`,side:'right',model:{providerId:'test',modelId:'model',parameters:{}},variant:{mode:'without_target_skill',skillId:'skill'},skill:null,environment:{environmentId:'env'},timeoutMs:10_000});
  await adapter.prepare({runId:'run'});cleanup.push(()=>adapter.cleanup());return adapter;
}

const request={runId:'run',side:'right' as const,model:{providerId:'test',modelId:'model'},variant:{mode:'without_target_skill' as const,skillId:'skill'},evalCase:{caseId:'case',name:'case',taskMode:'single_turn' as const,prompt:'test',evaluationGoal:'test',requiredTools:[],workspaceFiles:[],rubric:[]}};

it('rejects an oversized SSE frame before JSON parsing',async()=>{
  await expect((await launcher('oversized-frame')).execute(request)).rejects.toThrow(/SSE frame exceeds/u);
});

it('applies a separate serialized limit to terminal evidence',async()=>{
  await expect((await launcher('oversized-evidence')).execute(request)).rejects.toThrow(/evidence exceeds/u);
  await expect((await launcher('oversized-json-evidence')).execute(request)).rejects.toThrow(/evidence exceeds/u);
});

it('rejects a stream that ends with an unfinished frame',async()=>{
  await expect((await launcher('unfinished')).execute(request)).rejects.toThrow(/unfinished frame/u);
});
