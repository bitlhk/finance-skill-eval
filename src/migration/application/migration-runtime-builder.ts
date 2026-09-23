import type {RuntimeBuildRequirements} from '../domain/migration-harness.js';

/** Reserved integration seam for the future service that builds and registers a Runtime.
 * Migration diagnosis produces RuntimeBuildRequirements today, but no implementation is
 * wired in until the Builder protocol and trust boundary are available. */
export interface RuntimeBuilder {
  submit(requirements:RuntimeBuildRequirements):Promise<{buildId:string}>;
  status(buildId:string):Promise<{status:'QUEUED'|'BUILDING'|'READY'|'FAILED';runtimeRegistrationUrl?:string;error?:string}>;
}

export const runtimeBuilderAvailability={configured:false as const,status:'UNDER_DEVELOPMENT' as const};
