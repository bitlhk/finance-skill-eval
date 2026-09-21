import type { RuntimeAdapter, RuntimeExecutionRequest } from './adapters.js';
import type { ModelRef, SkillVariant } from './contracts.js';

/** Runs the assessed candidate once per case while preserving the existing two-side report contract. */
export class CandidateAssessmentRuntimeAdapter implements RuntimeAdapter {
  readonly adapterId:string;
  private readonly runs=new Map<string,ReturnType<RuntimeAdapter['execute']>>();
  constructor(private readonly inner:RuntimeAdapter,private readonly variant:SkillVariant,private readonly model:ModelRef){
    this.adapterId=`candidate-assessment:${inner.adapterId}`;
  }
  prepare(context:import('./adapters.js').RuntimePrepareContext){return this.inner.prepare?.(context)??Promise.resolve();}
  async execute(request:RuntimeExecutionRequest){
    const key=`${request.runId}:${request.evalCase.caseId}`;
    let execution=this.runs.get(key);
    if(!execution){
      execution=this.inner.execute({...request,side:'right',variant:this.variant,model:this.model,
        onEvent:event=>request.onEvent?.({...event,side:request.side})});
      this.runs.set(key,execution);
    }
    const evidence=await execution;
    return {...evidence,side:request.side,metadata:{...evidence.metadata,candidateAssessmentSourceSide:'right',candidateAssessmentReused:request.side==='left'}};
  }
  async cleanup(){this.runs.clear();await this.inner.cleanup?.();}
}
