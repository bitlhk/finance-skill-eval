import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {ExternalTraceCollector} from '../dist/evaluation/application/external-traces.js';
import {ObservedRuntime} from '../dist/evaluation/infrastructure/observed-runtime.js';
import {registerOtlpRoutes} from '../dist/interfaces/http/otlp-routes.js';
import {validateTelemetry} from '../dist/evaluation/domain/telemetry.js';

// Trace integration check against a user-specified local AgentScope project.
// Actual framework + Skill tool + SDK export; controlled model, no business writes or source edits.
const project=path.resolve(process.argv[2]??'');
if(!process.argv[2])throw Error('Pass the local AgentScope project directory');
const python=path.join(project,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const temporary=await mkdtemp(path.join(os.tmpdir(),'external-agent-otel-'));
const collector=new ExternalTraceCollector(100),app=Fastify();
const token='local-trace-integration';
app.addHook('onRequest',async(request,reply)=>{if(request.headers.authorization!=='Bearer '+token)return reply.code(401).send();});
registerOtlpRoutes(app,collector,true);
const run=promisify(execFile);
const script=String.raw`
import json, sys
from fastapi.testclient import TestClient
from agentscope.model import ChatModelBase, ChatResponse
from app.config import Settings
from app.main import create_app
class Model(ChatModelBase):
    def __init__(self):
        super().__init__('trace-integration', False)
        self.calls=0
    async def __call__(self, messages, **kwargs):
        self.calls+=1
        if self.calls==1:
            return ChatResponse(content=[{'type':'tool_use','id':'read','name':'read_agent_skill','input':{'skill_name':'meetingroom_booking'}}])
        return ChatResponse(content=[{'type':'text','text':'Trace integration completed'}])
config=Settings(_env_file=None,AGENT_DB_PATH=sys.argv[1],AGENT_API_KEY='local-test',OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=sys.argv[2])
headers={'Authorization':'Bearer local-test','X-User-Id':'trace-test','traceparent':sys.argv[3]}
with TestClient(create_app(config,Model)) as client:
    session=client.post('/v1/sessions',headers=headers).json()['id']
    response=client.post('/v1/chat',headers=headers,json={'session_id':session,'message':'Read the booking skill instructions only. Do not book or modify anything.'})
    response.raise_for_status()
    print(json.dumps({'reply':response.json()['reply'],'traceId':response.headers['x-trace-id']}))
`;
try{
  const url=await app.listen({host:'127.0.0.1',port:0});
  assert.equal((await app.inject({method:'POST',url:'/api/telemetry/v1/traces',payload:{}})).statusCode,401);
  const runtime=new ObservedRuntime({adapterId:'agentscope-otel-integration',execute:async request=>{
    const result=await run(python,['-B','-c',script,path.join(temporary,'sessions.sqlite3'),url+'/api/telemetry/v1/traces',request.traceparent],
      {cwd:project,windowsHide:true,timeout:40000,maxBuffer:256000,env:{...process.env,PYTHONUTF8:'1',OTEL_EXPORTER_OTLP_TRACES_HEADERS:'Authorization=Bearer '+token}});
    const response=JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(response.traceId,request.traceparent.split('-')[1]);
    return {runId:request.runId,caseId:request.evalCase.caseId,side:request.side,modelId:'trace-integration',status:'completed',
      output:response.reply,skillVersion:null,elapsedMs:0,toolCalls:[],loadedSkills:[],usage:null,error:null,
      runtimeIdentityVerified:false,streamCompleted:true,metadata:{}};
  }},collector);
  const identity={runId:'trace-integration',caseId:'read-skill',side:'right'};
  const result=await runtime.execute({...identity,evalCase:{caseId:identity.caseId}});
  const telemetry=validateTelemetry(result.metadata.telemetry,identity);
  assert.equal(telemetry.status,'PARTIAL');
  const names=telemetry.otlp.resourceSpans.flatMap(r=>r.scopeSpans.flatMap(s=>s.spans.map(span=>span.name)));
  assert.ok(names.includes('POST /v1/chat'));assert.ok(names.includes('execute_case'));
  assert.ok(result.metadata.telemetry.receivedSpans>=4);
  console.log(JSON.stringify({status:'PASSED',receivedSpans:result.metadata.telemetry.receivedSpans,spanNames:names,
    collectionStatus:telemetry.status,businessAcceptance:'NOT_EVALUATED',sourceModified:false}));
}finally{await app.close();await rm(temporary,{recursive:true,force:true});}
