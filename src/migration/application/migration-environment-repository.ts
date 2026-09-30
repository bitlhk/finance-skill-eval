import type { EnvironmentRecord } from '../../shared/contracts/environment.js';

export interface MigrationEnvironmentRepository {
  get(environmentId:string):Promise<EnvironmentRecord|null>;
  preflight?(record:EnvironmentRecord):Promise<{status:string;capabilities?:{runtime:{type:string;version:string}}}>;
}

export async function resolveManagedMigrationEnvironment(
  repository:MigrationEnvironmentRepository|undefined,
  environmentId:string,
):Promise<ResolvedMigrationEnvironment|null>{
  const resolved=await resolveMigrationEnvironment(repository,environmentId);
  if(!resolved)return null;
  if(['openjiuwen','agentscope'].includes(resolved.launcher.runtimeType))return resolved;
  if(resolved.launcher.runtimeType!=='generic_http'||!repository?.preflight)return null;
  try{
    const result=await repository.preflight(resolved.selected);
    const runtime=result.capabilities?.runtime;
    if(result.status!=='ready'||!runtime
        ||!((runtime.type==='openjiuwen'&&runtime.version==='0.1.15')
          ||(runtime.type==='agentscope'&&runtime.version==='2.0.3')))return null;
    return {...resolved,launcher:{...resolved.launcher,runtimeType:runtime.type as 'openjiuwen'|'agentscope'}};
  }catch{return null;}
}

export type MigrationLauncher=Extract<EnvironmentRecord,{type:'runtime_launcher'}>;
export type ResolvedMigrationEnvironment={
  selected:Extract<EnvironmentRecord,{type:'runtime_launcher'|'execution_environment'}>;
  launcher:MigrationLauncher;
};

export async function resolveMigrationEnvironment(
  repository:MigrationEnvironmentRepository|undefined,
  environmentId:string,
):Promise<ResolvedMigrationEnvironment|null>{
  const selected=await repository?.get(environmentId);
  if(selected?.type==='runtime_launcher')return {selected,launcher:selected};
  if(selected?.type!=='execution_environment')return null;
  const launcher=await repository?.get(selected.launcherEnvironmentId);
  return launcher?.type==='runtime_launcher'?{selected,launcher}:null;
}
