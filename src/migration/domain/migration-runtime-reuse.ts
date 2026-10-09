import {canonicalSha256} from '../../shared/json-canonicalization.js';
import type {RuntimeLauncherCapabilities} from '../../shared/contracts/runtime-launcher.js';
import type {RuntimeBuildRequirementState} from './migration-harness.js';
import type {MigrationProject,RuntimeReuse} from './migration-project.js';
import {currentRuntimeRequirements} from './migration-runtime-requirements.js';

/** Conservative exact contract matching. Unknown or differently worded contracts need diagnosis;
 * a matching tool name alone never proves semantic or authorization compatibility. */
export function runtimeReuseIssues(requirements:RuntimeBuildRequirementState,capabilities:RuntimeLauncherCapabilities):string[]{
  if(!('requirementsDigest' in requirements))return ['INCOMPLETE_REQUIREMENTS'];
  if(requirements.rebuild)return ['REBUILD_REQUIRED'];
  const issues:string[]=[];
  if(requirements.target.runtimeType!==capabilities.runtime.type)issues.push('RUNTIME_TYPE_MISMATCH');
  for(const requirement of requirements.requiredCapabilities.filter(item=>item.required)){
    const target=requirement.preferredTargetCapability??requirement.name;
    const matches=(capabilities.nativeCapabilities??[]).filter(item=>item.capabilityId===target||item.name===target);
    if(matches.length!==1){issues.push(`CAPABILITY_NOT_DECLARED:${requirement.name}`);continue;}
    const match=matches[0]!;
    if(canonicalSha256(match.contract)!==canonicalSha256(requirement.contract))issues.push(`CONTRACT_MISMATCH:${requirement.name}`);
    const constraints=(value:typeof match.constraints)=>({...value,permissions:[...new Set(value.permissions)].sort()});
    if(canonicalSha256(constraints(match.constraints))!==canonicalSha256(constraints(requirement.constraints)))issues.push(`CONSTRAINTS_MISMATCH:${requirement.name}`);
  }
  return issues;
}

export function currentRuntimeReuse(project:MigrationProject):RuntimeReuse|null{
  const requirements=currentRuntimeRequirements(project),reuse=project.runtimeReuse;
  return reuse&&requirements&&'requirementsDigest' in requirements&&!requirements.rebuild
    &&reuse.requirementsDigest===requirements.requirementsDigest?reuse:null;
}

/** Pins reused declarations in run revisions without fabricating a Builder artifact. */
export function reusedCapabilitiesDigest(project:MigrationProject,environment:{selected:{environmentId:string};launcher:{environmentId:string;updatedAt:string}}):string|undefined{
  const reuse=currentRuntimeReuse(project);
  return reuse?.environmentId===environment.selected.environmentId&&reuse.launcherEnvironmentId===environment.launcher.environmentId
    &&reuse.environmentUpdatedAt===environment.launcher.updatedAt?reuse.capabilitiesDigest:undefined;
}
