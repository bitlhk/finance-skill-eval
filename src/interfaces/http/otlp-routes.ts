import type {FastifyInstance} from 'fastify';
import {gunzipSync} from 'node:zlib';
import {decodeOtlp} from '../../evaluation/infrastructure/otlp-codec.js';
import type {ExternalTraceCollector} from '../../evaluation/application/external-traces.js';

export function registerOtlpRoutes(app:FastifyInstance,collector:ExternalTraceCollector,enabled:boolean){
  app.addContentTypeParser('application/x-protobuf',{parseAs:'buffer'},(_request,body,done)=>done(null,body));
  // Under /api: the existing workspace authentication applies, including tenant routing.
  app.post('/api/telemetry/v1/traces',{bodyLimit:2*1024*1024},async(request,reply)=>{
    if(!enabled)return reply.code(403).send({message:'OTLP ingress requires a private workspace'});
    try{
      const protobuf=String(request.headers['content-type']).split(';')[0]==='application/x-protobuf';
      const encoding=request.headers['content-encoding'];
      if(encoding&&encoding!=='identity'&&!(encoding==='gzip'&&protobuf))return reply.code(415).send();
      const payload=protobuf?decodeOtlp(encoding==='gzip'?gunzipSync(request.body as Buffer,{maxOutputLength:2*1024*1024}):request.body as Buffer):request.body;
      collector.ingest(payload);
      return protobuf?reply.type('application/x-protobuf').send(Buffer.alloc(0)):reply.send({});
    }catch{return reply.code(400).send({message:'Invalid OTLP trace payload'});}
  });
}
