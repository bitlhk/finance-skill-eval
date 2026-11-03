import path from 'node:path';
import {fileURLToPath} from 'node:url';
import protobuf from 'protobufjs';

// Upstream OpenTelemetry protobuf definitions, distributed with the pinned promptfoo dependency.
const directory=fileURLToPath(new URL('../../../contracts/otlp/',import.meta.url));
const root=new protobuf.Root();
root.resolvePath=(_origin,target)=>path.join(directory,target);
root.loadSync('opentelemetry/proto/collector/trace/v1/trace_service.proto');
const request=root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest');
export function decodeOtlp(buffer:Uint8Array):unknown{
  const value=request.toObject(request.decode(buffer),{longs:String,bytes:Array,enums:Number});
  function identifiers(item:unknown):void{
    if(!item||typeof item!=='object')return;
    for(const [key,value] of Object.entries(item)){
      if(['traceId','spanId','parentSpanId'].includes(key)&&Array.isArray(value))
        (item as Record<string,unknown>)[key]=Buffer.from(value).toString('hex');
      else identifiers(value);
    }
  }
  identifiers(value);return value;
}
