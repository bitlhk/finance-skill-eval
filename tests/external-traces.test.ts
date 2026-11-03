import {expect,it} from 'vitest';
import Fastify from 'fastify';
import path from 'node:path';
import protobuf from 'protobufjs';
import {gzipSync} from 'node:zlib';
import {ExternalTraceCollector} from '../src/evaluation/application/external-traces.js';
import {ObservedRuntime} from '../src/evaluation/infrastructure/observed-runtime.js';
import {validateTelemetry} from '../src/evaluation/domain/telemetry.js';
import {registerOtlpRoutes} from '../src/interfaces/http/otlp-routes.js';
import {RuntimeCaseNotExecutedError} from '../src/adapters.js';

const identity={runId:'run',caseId:'case',side:'right'};
const payload=(traceId:string,spanId='1234567890abcdef')=>({resourceSpans:[{scopeSpans:[{spans:[{traceId,spanId,name:'tool call',startTimeUnixNano:'1',endTimeUnixNano:'2'}]}]}]});
it('correlates standard Trace IDs without requiring platform attributes from business code',async()=>{
  const collector=new ExternalTraceCollector(0),a=collector.begin(identity),b=collector.begin({...identity,caseId:'other'});
  collector.ingest(payload(a.traceId));collector.ingest(payload(a.traceId));collector.ingest(payload('f'.repeat(32)));
  const result=await collector.finish(a.traceId);
  expect(result).toMatchObject({status:'PARTIAL',receivedSpans:1});
  expect(validateTelemetry(result,identity)).toMatchObject({status:'PARTIAL'});
  expect(await collector.finish(b.traceId)).toMatchObject({status:'UNAVAILABLE',receivedSpans:0});
  expect(collector.ingest(payload(a.traceId))).toBe(0);
});
it('bounds received spans and does not infer complete collection from a successful export',async()=>{
  const collector=new ExternalTraceCollector(0),a=collector.begin(identity);
  for(let i=1;i<245;i++)collector.ingest(payload(a.traceId,i.toString(16).padStart(16,'0')));
  expect(await collector.finish(a.traceId)).toMatchObject({status:'PARTIAL',receivedSpans:240,reason:'Collection limit reached'});
});
it.each([false,true])('accepts standard OTLP protobuf with gzip=%s',async compressed=>{
  const collector=new ExternalTraceCollector(0),a=collector.begin(identity),app=Fastify();
  registerOtlpRoutes(app,collector,true);
  const root=new protobuf.Root();root.resolvePath=(_origin,target)=>path.resolve('contracts/otlp',target);
  root.loadSync('opentelemetry/proto/collector/trace/v1/trace_service.proto');
  const type=root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest');
  const value=payload(a.traceId) as any;const span=value.resourceSpans[0].scopeSpans[0].spans[0];
  span.traceId=Buffer.from(span.traceId,'hex');span.spanId=Buffer.from(span.spanId,'hex');
  const encoded=Buffer.from(type.encode(type.fromObject(value)).finish());
  try{
    const response=await app.inject({method:'POST',url:'/api/telemetry/v1/traces',headers:{'content-type':'application/x-protobuf',...(compressed?{'content-encoding':'gzip'}:{})},payload:compressed?gzipSync(encoded):encoded});
    expect(response.statusCode,response.body).toBe(200);expect(response.rawPayload.length).toBe(0);
    expect(await collector.finish(a.traceId)).toMatchObject({receivedSpans:1});
  }finally{await app.close();}
});
it('rejects malformed input and disables ingress outside private workspaces',async()=>{
  for(const enabled of [true,false]){
    const app=Fastify();registerOtlpRoutes(app,new ExternalTraceCollector(0),enabled);
    try{expect((await app.inject({method:'POST',url:'/api/telemetry/v1/traces',payload:{invalid:true}})).statusCode).toBe(enabled?400:403);}
    finally{await app.close();}
  }
});
it('keeps existing runtime evidence and blocked-case semantics',async()=>{
  const collector=new ExternalTraceCollector(0),original={metadata:{telemetry:{status:'COMPLETE',source:'existing'}}};
  const runtime=new ObservedRuntime({adapterId:'test',execute:async request=>{
    expect(request.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);return original as any;
  }},collector);
  const request={...identity,evalCase:{caseId:'case'}} as any;
  expect((await runtime.execute(request)).metadata.telemetry).toEqual(original.metadata.telemetry);
  const blocked=new ObservedRuntime({adapterId:'test',execute:async()=>{throw new RuntimeCaseNotExecutedError('prior');}},collector);
  await expect(blocked.execute(request)).rejects.toBeInstanceOf(RuntimeCaseNotExecutedError);
});
