import {z} from 'zod';
const span=z.object({traceId:z.string().regex(/^[a-f0-9]{32}$/i),spanId:z.string().regex(/^[a-f0-9]{16}$/i),
  parentSpanId:z.string().regex(/^[a-f0-9]{16}$/i).optional(),name:z.string().max(500),
  startTimeUnixNano:z.string().regex(/^\d+$/),endTimeUnixNano:z.string().regex(/^\d+$/),
  attributes:z.array(z.object({key:z.string(),value:z.record(z.unknown())})).optional(),
}).passthrough();
export const telemetrySchema=z.object({status:z.enum(['COMPLETE','PARTIAL','UNAVAILABLE']),
  source:z.string().max(100),scope:z.string().max(200),exportStatus:z.string().optional(),
  otlp:z.object({resourceSpans:z.array(z.object({resource:z.unknown().optional(),scopeSpans:z.array(z.object({
    scope:z.unknown().optional(),spans:z.array(span).max(256),
  }).passthrough()).max(64)}).passthrough()).max(64)}).passthrough(),
}).passthrough();
export function validateTelemetry(value:unknown,identity?:{runId:string;caseId:string;side:string}){
  const parsed=telemetrySchema.safeParse(value);
  if(!parsed.success)return {status:'UNAVAILABLE',source:'runtime',scope:'unknown',reason:'Invalid OTLP evidence'};
  const telemetry=parsed.data;
  const spans=telemetry.otlp.resourceSpans.flatMap(r=>r.scopeSpans.flatMap(s=>s.spans));
  if(spans.length>256||JSON.stringify(telemetry).length>128000)return {status:'PARTIAL',source:telemetry.source,scope:telemetry.scope,reason:'Trace evidence exceeds collection limit'};
  if(!spans.length)return {...telemetry,status:'UNAVAILABLE'};
  if(spans.some(s=>BigInt(s.endTimeUnixNano)<BigInt(s.startTimeUnixNano))||new Set(spans.map(s=>s.traceId+':'+s.spanId)).size!==spans.length)
    return {status:'UNAVAILABLE',source:telemetry.source,scope:telemetry.scope,reason:'Invalid span identities or timestamps'};
  if(identity){
    const attributes=spans.flatMap(s=>s.attributes??[]);
    let missing=false;
    for(const [key,expected] of Object.entries({'finance.run.id':identity.runId,'finance.case.id':identity.caseId,'finance.side':identity.side})){
      const recorded=attributes.filter(a=>a.key===key);
      if(recorded.some(a=>a.value.stringValue!==expected))return {status:'UNAVAILABLE',source:telemetry.source,scope:telemetry.scope,reason:'Trace belongs to another execution'};
      if(!recorded.length)missing=true;
    }
    if(missing)return {...telemetry,status:'PARTIAL',reason:'Trace correlation attributes are missing'};
  }
  return telemetry;
}
