import type { EnvironmentRecord } from '../../shared/contracts/environment.js';

export interface MigrationEnvironmentRepository {
  get(environmentId:string):Promise<EnvironmentRecord|null>;
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
