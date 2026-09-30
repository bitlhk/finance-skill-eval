import type {ProjectInspection,RuntimeHarnessCapability} from './migration-model.js';
import {withRequirementsDigest,type RuntimeBuildRequirementsV1} from '../../shared/contracts/runtime-builder.js';
import {RUNTIME_CAPABILITIES_SCHEMA_VERSION,RUNTIME_EXECUTION_SCHEMA_VERSION,RUNTIME_INSTANCE_SCHEMA_VERSION,RUNTIME_OBSERVATION_SCHEMA_VERSION} from '../../shared/contracts/runtime-protocol-versions.js';

const callableHarnessName=/^[\p{L}_][\p{L}\p{N}_.:-]*$/u;
const frameworkPlumbing=/\b(?:ToolBase|BaseTool|ToolResponse|Toolkit|TextBlock|register_tool|register_tool_function)\b/iu;
const plumbingRole=/(?:注册|结果构造|返回包装|适配层|框架(?:基类|容器|SDK)|registration|result wrapper|framework glue)/iu;

/** Framework glue is replaced by the migrated MCP/Script boundary. Only independently callable
 * source-Runtime behavior becomes a contract for an external Runtime Builder. */
export function isAdaptableHarnessCapability(capability:Pick<RuntimeHarnessCapability,'name'|'reason'|'usageContract'|'evidence'>):boolean{
  const name=capability.name.trim();
  if(!callableHarnessName.test(name))return false;
  const description=[name,capability.reason,capability.usageContract,...capability.evidence.map(item=>item.detail)].join('\n');
  return !(frameworkPlumbing.test(description)&&plumbingRole.test(description));
}

export function adaptableHarnessCapabilities(inspection:ProjectInspection):RuntimeHarnessCapability[]{
  return (inspection.runtimeCapabilities??[]).filter(isAdaptableHarnessCapability);
}

export type RuntimeBuildRequirementState=RuntimeBuildRequirementsV1|{
  schemaVersion:'finance.runtime-build-requirements.v1';status:'INCOMPLETE_REQUIREMENTS';
  missing:Array<{name:string;fields:string[]}>;
};

export function runtimeBuildRequirements(inspection:ProjectInspection, target:{runtimeType:string;requestId?:string}={runtimeType:'openjiuwen'}):RuntimeBuildRequirementState|null{
  const capabilities=adaptableHarnessCapabilities(inspection);
  if(!capabilities.length)return null;
  const missing=capabilities.flatMap(capability=>{
    const fields=[...(!capability.contract?['contract']:[]),...(!capability.constraints?['constraints']:[])];
    return fields.length?[{name:capability.name,fields}]:[];
  });
  if(missing.length)return {schemaVersion:'finance.runtime-build-requirements.v1',status:'INCOMPLETE_REQUIREMENTS',missing};
  return withRequirementsDigest({
    schemaVersion:'finance.runtime-build-requirements.v1' as const,
    requestId:target.requestId??`${inspection.assetId}:${inspection.assetDigest.slice(0,12)}:${target.runtimeType}`,
    source:{assetId:inspection.assetId,artifactSha256:inspection.assetDigest},
    target:{runtimeType:target.runtimeType,protocols:{capabilities:RUNTIME_CAPABILITIES_SCHEMA_VERSION,instance:RUNTIME_INSTANCE_SCHEMA_VERSION,execution:RUNTIME_EXECUTION_SCHEMA_VERSION,observation:RUNTIME_OBSERVATION_SCHEMA_VERSION}},
    requiredCapabilities:capabilities.map((capability,index)=>({
      id:`harness-${index+1}-${capability.name.toLowerCase().replace(/[^a-z0-9]+/gu,'-').replace(/^-|-$/gu,'')||'capability'}`,
      name:capability.name,required:true as const,reason:capability.reason,contract:capability.contract!,constraints:capability.constraints!,
      preferredTargetCapability:capability.targetCapability,consumerTools:[...capability.consumerTools].sort(),
      evidence:capability.evidence.map(({path,line,detail})=>({path,line,detail})),
    })),
  });
}
