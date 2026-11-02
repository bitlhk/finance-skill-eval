import {prepareModelRole} from './model-role.js';
import {createHash} from 'node:crypto';
import type {ModelAdapter} from '../adapters.js';
import type {ModelRef} from '../contracts.js';
import {improvementJudgementSchema, ImprovementPlanningError, type ImprovementJudgement} from '../improvement/domain/diagnosis.js';
import {correctModelOutput, type OutputCheck} from './model-output-correction.js';
import {normalizeCapabilityConstraints} from '../shared/contracts/runtime-capability.js';
import {loadAgentRole} from './composition.js';
import type {ImprovementDiagnoser} from '../improvement/application/diagnosis-port.js';
import {boundedAgentCall} from './bounded-call.js';

function normalizeRepresentation(value:unknown):unknown{
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const original=value as Record<string,unknown>;
  if(original.status!=='PROPOSED'||!original.hypothesis||typeof original.hypothesis!=='object')return value;
  const hypothesis=original.hypothesis as Record<string,unknown>;
  return {...original,hypothesis:{...hypothesis,
    ...(typeof hypothesis.confidence==='string'&&['low','medium','high'].includes(hypothesis.confidence.trim().toLowerCase())
      ?{confidence:hypothesis.confidence.trim().toUpperCase()}:{}),
    ...(Array.isArray(hypothesis.requiredCapabilities)?{requiredCapabilities:hypothesis.requiredCapabilities.map(item=>{
      if(!item||typeof item!=='object')return item;
      const capability=item as Record<string,unknown>;
      return {...capability,constraints:normalizeCapabilityConstraints(capability.constraints)};
    })}:{})}};
}

function checkJudgement(value:unknown):OutputCheck<ImprovementJudgement>{
  const parsed=improvementJudgementSchema.safeParse(normalizeRepresentation(value));
  if(parsed.success&&parsed.data.status==='PROPOSED'&&parsed.data.hypothesis.layer==='HARNESS'&&!parsed.data.hypothesis.requiredCapabilities?.length)
    return {ok:false,errors:['hypothesis.requiredCapabilities: Harness 改进必须给出有真实证据的 Builder 能力合同；证据不足则 ABSTAINED']};
  return parsed.success?{ok:true,value:parsed.data}:{ok:false,errors:parsed.error.issues.map(issue=>
    `${issue.path.join('.').slice(0,150)||'$'} (${issue.code})`)};
}

function preservesProposal(original:unknown,repaired:unknown):boolean{
  if(!original||typeof original!=='object'||Array.isArray(original))return true;
  const before=normalizeRepresentation(original) as Record<string,unknown>;
  if(before.status!=='PROPOSED')return true;
  if(repaired&&typeof repaired==='object'&&!Array.isArray(repaired)&&(repaired as Record<string,unknown>).status==='ABSTAINED')return true;
  const after=normalizeRepresentation(repaired) as Record<string,unknown>;
  const beforeHypothesis=before.hypothesis,afterHypothesis=after?.hypothesis;
  if(!beforeHypothesis||typeof beforeHypothesis!=='object'||!afterHypothesis||typeof afterHypothesis!=='object')return false;
  const fields=['layer','issue','expectedBehavior','evidenceCaseIds','validation','risk','confidence','toolIds','requiredCapabilities','projectPaths'];
  for(const key of fields)if(JSON.stringify((beforeHypothesis as Record<string,unknown>)[key])
    !==JSON.stringify((afterHypothesis as Record<string,unknown>)[key]))return false;
  return before.status===after.status;
}

/** An evidence-bound diagnosis. It cannot edit assets, invoke business tools or adopt a candidate. */
export function createImprovementDiagnoser(dependencies: {adapter:ModelAdapter; model:ModelRef;
  capabilityFormat:unknown; policies?:string[]}): ImprovementDiagnoser {
  return async (input, options) => boundedAgentCall(options,async signal=>{
    const composition=loadAgentRole('improvement-diagnosis',options.version);
    const policies=dependencies.policies??[];
    const roleCall=await prepareModelRole(composition,{input,policies,capabilityFormat:dependencies.capabilityFormat},
      options,dependencies,signal,[...policies,'已发布的 Builder JSON Schema：'+JSON.stringify(dependencies.capabilityFormat)]);
    const receipt=roleCall.receipt;
    const completion=await roleCall.complete(input);
  let validationFields:string[]=[];
  const corrected=await correctModelOutput({raw:completion.content,check:value=>{
    const checked=checkJudgement(value);if(!checked.ok)validationFields=checked.errors.slice(0,16);return checked;
  },adapter:dependencies.adapter,
    model:dependencies.model,requestId:options.requestId,signal,preserve:preservesProposal});
  if(!corrected.ok)throw new ImprovementPlanningError(validationFields,corrected.error==='纠错结果改变了原始判断或证据'?'MODEL_CORRECTION_CHANGED_FACTS':'MODEL_OUTPUT_INVALID');
  const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
  return {judgement:corrected.value,agentComposition:receipt,outputCorrection:{attempts:corrected.repairs,
    originalDigest:digest(completion.content),acceptedDigest:digest(JSON.stringify(corrected.value))}};
  });
}
