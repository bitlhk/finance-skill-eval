import {createHash} from 'node:crypto';
import {stringify} from 'yaml';
import type {ProjectInspection,RuntimeHarnessCapability} from '../migration/domain/migration-model.js';

const callableHarnessName=/^[\p{L}_][\p{L}\p{N}_.:-]*$/u;
const frameworkPlumbing=/\b(?:ToolBase|BaseTool|ToolResponse|Toolkit|TextBlock|register_tool|register_tool_function)\b/iu;
const plumbingRole=/(?:注册|结果构造|返回包装|适配层|框架(?:基类|容器|SDK)|registration|result wrapper|framework glue)/iu;

/** Framework glue is replaced by the migrated MCP/Script boundary. Only independently callable
 * source-Runtime behavior becomes a future Runtime Builder requirement. */
export function isAdaptableHarnessCapability(capability:Pick<RuntimeHarnessCapability,'name'|'reason'|'usageContract'|'evidence'>):boolean{
  const name=capability.name.trim();
  if(!callableHarnessName.test(name))return false;
  const description=[name,capability.reason,capability.usageContract,...capability.evidence.map(item=>item.detail)].join('\n');
  return !(frameworkPlumbing.test(description)&&plumbingRole.test(description));
}

export function adaptableHarnessCapabilities(inspection:ProjectInspection):RuntimeHarnessCapability[]{
  return (inspection.runtimeCapabilities??[]).filter(isAdaptableHarnessCapability);
}

export type RuntimeBuildRequirements={
  schemaVersion:'finance.runtime-build-requirements.v1';
  status:'RUNTIME_BUILDER_REQUIRED';
  source:{assetId:string;artifactSha256:string};
  targetProtocol:{registration:string;instance:string;execution:string};
  requiredCapabilities:Array<{
    id:string;name:string;required:true;reason:string;usageContract:string;
    targetCapability:string|null;consumerTools:string[];
    evidence:Array<{path:string;line:number;detail:string}>;
  }>;
  requirementsDigest:string;
};

export function runtimeBuildRequirements(inspection:ProjectInspection):RuntimeBuildRequirements|null{
  const capabilities=adaptableHarnessCapabilities(inspection);
  if(!capabilities.length)return null;
  const body={
    schemaVersion:'finance.runtime-build-requirements.v1' as const,
    status:'RUNTIME_BUILDER_REQUIRED' as const,
    source:{assetId:inspection.assetId,artifactSha256:inspection.assetDigest},
    targetProtocol:{registration:'finance.skill-eval.runtime-capabilities.v2',instance:'finance.skill-eval.runtime-instance.v1',execution:'finance.skill-eval.runtime-case.v1'},
    requiredCapabilities:capabilities.map((capability,index)=>({
      id:`harness-${index+1}-${capability.name.toLowerCase().replace(/[^a-z0-9]+/gu,'-').replace(/^-|-$/gu,'')||'capability'}`,
      name:capability.name,required:true as const,reason:capability.reason,usageContract:capability.usageContract,
      targetCapability:capability.targetCapability,consumerTools:[...capability.consumerTools].sort(),
      evidence:capability.evidence.map(({path,line,detail})=>({path,line,detail})),
    })),
  };
  const requirementsDigest=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return {...body,requirementsDigest};
}

export function runtimeBuildRequirementsYaml(inspection:ProjectInspection):string|null{
  const requirements=runtimeBuildRequirements(inspection);
  return requirements?stringify(requirements,{lineWidth:0}):null;
}
