import type { EnvironmentRecord } from '../../shared/contracts/environment.js';
import type {RuntimeLauncherCapabilities} from '../../shared/contracts/runtime-launcher.js';
import type {MigrationProject} from '../domain/migration-project.js';
import {currentRuntimeReuse,runtimeReuseIssues} from '../domain/migration-runtime-reuse.js';
import {currentRuntimeRequirements} from '../domain/migration-runtime-requirements.js';
import {canonicalSha256} from '../../shared/json-canonicalization.js';
import {runtimeLauncherBindingSchema} from '../../shared/contracts/environment.js';

export interface MigrationEnvironmentRepository {
  get(environmentId:string):Promise<EnvironmentRecord|null>;
  preflight?(record:EnvironmentRecord):Promise<{status:string;capabilities?:RuntimeLauncherCapabilities}>;
  nativeToolCatalog?(environmentId:string):Promise<import('../../shared/contracts/native-tool-catalog.js').NativeBindingTarget>;
}

/** Legacy generic registrations need an online identity declaration, not a guessed framework. */
export async function resolveManagedMigrationEnvironment(repository:MigrationEnvironmentRepository|undefined,environmentId:string){
  const resolved=await resolveMigrationEnvironment(repository,environmentId);
  if(!resolved||resolved.launcher.runtimeType!=='generic_http')return resolved;
  const proof=await repository?.preflight?.(resolved.selected);
  const runtime=proof?.capabilities?.runtime;
  return proof?.status==='ready'&&runtime&&runtime.version!=='unknown'&&runtime.version.trim()?resolved:null;
}

export async function migrationRuntimeCapabilities(repository:MigrationEnvironmentRepository|undefined,environmentId:string){
  const resolved=await resolveMigrationEnvironment(repository,environmentId);
  if(!resolved)throw Object.assign(new Error('请选择已登记的 Runtime Launcher'),{statusCode:409});
  const result=await repository?.preflight?.(resolved.selected);
  if(result?.status!=='ready'||!result.capabilities)throw Object.assign(new Error('无法读取所选 Runtime 的能力声明，请检查连接后重试'),{statusCode:409});
  return {...resolved,capabilities:result.capabilities};
}

export async function verifyRuntimeReuse(project:MigrationProject,repository:MigrationEnvironmentRepository|undefined,environmentId:string){
  const reuse=currentRuntimeReuse(project);
  if(!reuse){
    if(project.runtimeReuse&&currentRuntimeRequirements(project))throw Object.assign(new Error('能力需求已变化，请重新核对 Runtime'),{statusCode:409});
    return;
  }
  if(reuse.environmentId!==environmentId){
    // Another deployment is usable only through its own current operator admission,
    // never by borrowing the primary deployment's capability confirmation.
    if(!await resolveMigrationEnvironment(repository,environmentId))throw Object.assign(new Error('请选择已核对能力的 Runtime，切换后需重新检查'),{statusCode:409});
    const live=await migrationRuntimeCapabilities(repository,environmentId);
    const accepted=runtimeLauncherBindingSchema.safeParse(project.runtimeDeliveries?.[live.launcher.environmentId]);
    const requirements=currentRuntimeRequirements(project,live.launcher.runtimeType);
    if(accepted.success&&requirements&&'requirementsDigest' in requirements
      &&accepted.data.requirementsDigest===requirements.requirementsDigest&&accepted.data.requestId===requirements.requestId
      &&accepted.data.environmentId===live.launcher.environmentId&&live.launcher.delivery){
      const {environmentId:_id,...delivery}=accepted.data;
      if(canonicalSha256(delivery)===canonicalSha256(live.launcher.delivery)
        &&delivery.capabilitiesDigest===canonicalSha256(live.capabilities)
        &&runtimeReuseIssues(requirements,live.capabilities).length===0
        &&(delivery.expiresAt===null||Date.parse(delivery.expiresAt)>Date.now()))return;
    }
    throw Object.assign(new Error('请选择已核对能力的 Runtime，切换后需重新检查；其他部署需独立准入'),{statusCode:409});
  }
  const live=await migrationRuntimeCapabilities(repository,environmentId),requirements=currentRuntimeRequirements(project)!;
  if(live.launcher.environmentId!==reuse.launcherEnvironmentId||live.launcher.updatedAt!==reuse.environmentUpdatedAt
    ||canonicalSha256(live.capabilities)!==reuse.capabilitiesDigest||runtimeReuseIssues(requirements,live.capabilities).length)
    throw Object.assign(new Error('Runtime 能力或连接已变化，请重新核对；不会沿用之前的复用结论'),{statusCode:409});
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
  if(selected?.archived)return null;
  if(selected?.type==='runtime_launcher')return {selected,launcher:selected};
  if(selected?.type!=='execution_environment')return null;
  const launcher=await repository?.get(selected.launcherEnvironmentId);
  return launcher?.type==='runtime_launcher'&&!launcher.archived?{selected,launcher}:null;
}
