import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {telemetrySchema} from '../domain/telemetry.js';
type Otlp=ReturnType<typeof telemetrySchema.parse>['otlp'];
type Batch=Otlp['resourceSpans'][number];
type Session={traceId:string;spanId:string;start:string;created:number;resources:Batch[];ids:Set<string>;bytes:number;truncated:boolean;identity:{runId:string;caseId:string;side:string}};

/** Workspace-local, bounded correlation buffer. Unknown/late traces are never retained. */
export class ExternalTraceCollector{
  private readonly active=new Map<string,Session>();
  constructor(private readonly waitMs=5500){}
  begin(identity:Session['identity']){
    for(const [id,s] of this.active)if(Date.now()-s.created>20*60_000)this.active.delete(id);
    if(this.active.size>=128)throw new Error('Too many active trace collections');
    const session:Session={identity,traceId:randomBytes(16).toString('hex'),spanId:randomBytes(8).toString('hex'),
      start:String(BigInt(Date.now())*1_000_000n),created:Date.now(),resources:[],ids:new Set(),bytes:0,truncated:false};
    this.active.set(session.traceId,session);
    return {traceId:session.traceId,traceparent:`00-${session.traceId}-${session.spanId}-01`};
  }
  ingest(payload:unknown){
    const parsed=telemetrySchema.parse({status:'PARTIAL',source:'otlp',scope:'agent-process',otlp:payload});
    let accepted=0;
    for(const resource of parsed.otlp.resourceSpans)for(const scope of resource.scopeSpans)for(const span of scope.spans){
      const session=this.active.get(span.traceId.toLowerCase());if(!session)continue;
      const id=span.spanId.toLowerCase();if(session.ids.has(id))continue;
      const batch={...resource,scopeSpans:[{...scope,spans:[span]}]},size=Buffer.byteLength(JSON.stringify(batch));
      if(session.ids.size>=240||session.bytes+size>100_000){session.truncated=true;continue;}
      session.ids.add(id);session.bytes+=size;session.resources.push(batch);accepted++;
    }
    return accepted;
  }
  async finish(traceId:string,signal?:AbortSignal,wait=true){
    const session=this.active.get(traceId);if(!session)throw Error('Unknown trace collection');
    const end=String(BigInt(Date.now())*1_000_000n);
    try{
      // A batch is not a completion acknowledgement. Bound the wait, never infer completeness.
      if(wait&&!signal?.aborted)await delay(this.waitMs,undefined,{signal}).catch(error=>{if(!signal?.aborted)throw error;});
      const attributes=Object.entries({'finance.run.id':session.identity.runId,'finance.case.id':session.identity.caseId,'finance.side':session.identity.side})
        .map(([key,value])=>({key,value:{stringValue:value}}));
      return {status:session.ids.size?'PARTIAL':'UNAVAILABLE',source:'external-otlp',scope:'received-agent-spans',
        reason:session.truncated?'Collection limit reached':session.ids.size?'Export has no end-of-trace acknowledgement':'No correlated spans received',
        traceId,receivedSpans:session.ids.size,otlp:{resourceSpans:[...session.resources,{scopeSpans:[{scope:{name:'finance.evaluation'},spans:[{
          traceId,spanId:session.spanId,name:'execute_case',startTimeUnixNano:session.start,endTimeUnixNano:end,attributes,
        }]}]}]}};
    }finally{this.active.delete(traceId);}
  }
}
