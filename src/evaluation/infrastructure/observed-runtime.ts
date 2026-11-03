import type {RuntimeAdapter,RuntimeExecutionRequest,RuntimePrepareContext} from '../../adapters.js';
import {RuntimeExecutionFailure,RuntimeCaseNotExecutedError} from '../../adapters.js';
import type {ExternalTraceCollector} from '../application/external-traces.js';

/** Adds external evidence collection to the existing execution/lifecycle contract. */
export class ObservedRuntime implements RuntimeAdapter{
  readonly adapterId:string;
  constructor(private readonly inner:RuntimeAdapter,private readonly collector:ExternalTraceCollector){this.adapterId=inner.adapterId;}
  prepare(context:RuntimePrepareContext){return this.inner.prepare?.(context)??Promise.resolve();}
  supportsCaseState(request:RuntimeExecutionRequest){return this.inner.supportsCaseState?.(request)===true;}
  cleanup(){return this.inner.cleanup?.()??Promise.resolve();}
  finalizationEvidence(){return this.inner.finalizationEvidence?.()??{status:'UNKNOWN'};}
  async execute(request:RuntimeExecutionRequest){
    const collection=this.collector.begin({runId:request.runId,caseId:request.evalCase.caseId,side:request.side});
    let evidence;
    try{evidence=await this.inner.execute({...request,traceparent:collection.traceparent});}
    catch(error){
      const telemetry=await this.collector.finish(collection.traceId,request.signal,!(error instanceof RuntimeCaseNotExecutedError));
      if(error instanceof RuntimeCaseNotExecutedError||request.signal?.aborted)throw error;
      throw new RuntimeExecutionFailure(error instanceof Error?error.message:String(error),{
        ...(error instanceof RuntimeExecutionFailure?error.metadata:{}),telemetry});
    }
    const external=await this.collector.finish(collection.traceId,request.signal,evidence.metadata.telemetry===undefined);
    return {...evidence,metadata:{...evidence.metadata,
      ...(evidence.metadata.telemetry===undefined?{telemetry:external}:external.receivedSpans?{externalTelemetry:external}:{})}};
  }
}
