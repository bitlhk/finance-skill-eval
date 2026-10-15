import { z } from 'zod';
import {currentRuntimeRequirements} from '../domain/migration-runtime-requirements.js';
import type {RuntimeBuildRequirementState} from '../domain/migration-harness.js';
import {currentRuntimeReuse} from '../domain/migration-runtime-reuse.js';
import type { MigrationProject } from '../domain/migration-project.js';
import { runtimeLauncherBindingSchema, runtimeLauncherDeliverySchema } from '../../shared/contracts/environment.js';
import { canonicalSha256 } from '../../shared/json-canonicalization.js';
import { resolveManagedMigrationEnvironment,verifyRuntimeReuse, type MigrationEnvironmentRepository, type ResolvedMigrationEnvironment } from './migration-environment-repository.js';

// Legacy records lost the accepted requirements digest. They cannot discharge a
// current contract until re-admitted with that correspondence retained.
const correspondence = {requirementsDigest:z.string().regex(/^[a-f0-9]{64}$/u)};
const bindingSchema = runtimeLauncherBindingSchema.extend(correspondence);
const deliverySchema = runtimeLauncherDeliverySchema.extend(correspondence);

export async function unresolvedMigrationRuntimeRequirements(
  project:MigrationProject,
  environments:MigrationEnvironmentRepository|undefined,
  selected?:ResolvedMigrationEnvironment,
  override?:RuntimeBuildRequirementState,
) {
  let requirements=override??currentRuntimeRequirements(project,selected?.launcher.runtimeType??'openjiuwen');
  if(!requirements||!('requestId' in requirements))return requirements;
  const reuse=currentRuntimeReuse(project);
  if(reuse&&(!selected||reuse.environmentId===selected.selected.environmentId)){
    if(reuse.requirementsDigest!==requirements.requirementsDigest)return requirements;
    try{await verifyRuntimeReuse(project,environments,reuse.environmentId);return null;}catch{return requirements;}
  }
  const environmentId=selected?.launcher.environmentId;
  const candidate=environmentId?project.runtimeDeliveries?.[environmentId]
    ??(project.runtimeDelivery?.environmentId===environmentId?project.runtimeDelivery:undefined):project.runtimeDelivery;
  const binding=bindingSchema.safeParse(candidate);
  if(!binding.success)return requirements;
  const resolved=selected??await resolveManagedMigrationEnvironment(environments,binding.data.environmentId);
  if(!resolved||resolved.launcher.environmentId!==binding.data.environmentId)return requirements;
  requirements=override??currentRuntimeRequirements(project,resolved.launcher.runtimeType);
  if(!requirements||!('requestId' in requirements))return requirements;
  const delivery=deliverySchema.safeParse(resolved.launcher.delivery);
  if(!delivery.success)return requirements;
  const {environmentId:_environmentId,...boundDelivery}=binding.data;
  if(canonicalSha256(boundDelivery)!==canonicalSha256(delivery.data)
      ||delivery.data.requestId!==requirements.requestId
      ||delivery.data.requirementsDigest!==requirements.requirementsDigest
      ||(delivery.data.expiresAt!==null&&Date.parse(delivery.data.expiresAt)<=Date.now()))return requirements;
  return null;
}
