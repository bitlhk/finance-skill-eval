import {runtimeLauncherCapabilitiesSchema} from '../../shared/contracts/runtime-launcher.js';
import {runtimeFeatureIssues,type RuntimeFeature} from '../../shared/contracts/runtime-intake.js';
import {runtimeExecutionEvidenceSchema} from '../../contracts.js';
import {checkExecutionEvidence} from '../domain/execution-checks.js';
import {validateTelemetry} from '../domain/telemetry.js';
import {withRuntimeProcess} from '../domain/runtime-process.js';

/** Declaration checks and observed execution checks remain separate; neither grants business acceptance. */
export function inspectRuntimeIntake(input:{capabilities:unknown;features?:RuntimeFeature[];evidence?:unknown;identity?:{runId:string;caseId:string;side:string}}){
  const parsed=runtimeLauncherCapabilitiesSchema.safeParse(input.capabilities);
  const issues=parsed.success?runtimeFeatureIssues(parsed.data,['processEvidence',...input.features??[]]):parsed.error.issues.map(i=>`INVALID_CAPABILITIES_${i.path.join('.')}`);
  const compatible=issues.length===0;
  let execution:'NOT_PROVIDED'|'VERIFIED'|'INCOMPLETE'='NOT_PROVIDED';
  if(input.evidence!==undefined){
    const evidence=runtimeExecutionEvidenceSchema.safeParse(input.evidence);
    if(!evidence.success){issues.push('INVALID_EXECUTION_EVIDENCE');execution='INCOMPLETE';}
    else{
      const observed=evidence.data;
      const checks=checkExecutionEvidence(observed).filter(check=>check.status!=='PASS').map(check=>check.id);
      try{withRuntimeProcess(observed,true);}catch{checks.push('execution.process-invalid');}
      if(!input.identity)checks.push('execution.expected-identity-missing');
      else if(observed.runId!==input.identity.runId||observed.caseId!==input.identity.caseId||observed.side!==input.identity.side)checks.push('execution.correlation');
      if(input.features?.includes('projectExecution')&&(observed.metadata.projectExecution!==true||typeof observed.metadata.contentDigest!=='string'))checks.push('execution.project');
      if(input.features?.includes('otlpEvidence')||input.features?.includes('otlpExport')){
        const telemetry=validateTelemetry(observed.metadata.telemetry,input.identity);
        if(telemetry.status!=='COMPLETE')checks.push('execution.telemetry-incomplete');
      }
      issues.push(...checks);execution=checks.length?'INCOMPLETE':'VERIFIED';
    }
  }
  return {compatible,execution,issues,businessAcceptance:'NOT_EVALUATED' as const};
}
