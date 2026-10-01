import type {MigrationStore} from '../migration/migration-store.js';
import {KeyedQueue} from '../shared/keyed-queue.js';
import {runtimeBuildResultSchema} from '../shared/contracts/runtime-builder.js';
import type {EnvironmentStore} from './environment-store.js';

/** Keeps one deployment's registry write, migration binding and compensation in one critical section. */
export class RuntimeDeliveryCoordinator {
  private readonly deliveries=new KeyedQueue();

  constructor(private readonly migrations:MigrationStore,private readonly environments:EnvironmentStore){}

  async acceptAndBind(migrationId:string,input:{result:unknown;trustReference:string;name?:string}){
    const result=runtimeBuildResultSchema.parse(input.result);
    const key=result.launcher?.deploymentId??result.requestId;
    return this.deliveries.run(key,async()=>{
      const requirements=await this.migrations.runtimeRequirements(migrationId,result.launcher?.runtime.type);
      if(!requirements||!('requestId' in requirements))throw Object.assign(new Error('当前迁移没有可接收的 Runtime Builder 能力需求。'),{statusCode:409});
      const conformance=await this.migrations.conformanceCandidate(migrationId);
      const accepted=await this.environments.acceptBuilderDelivery({...input,result,requirements,conformance});
      const delivery=accepted.environment.delivery!;
      try{
        await this.migrations.bindRuntimeDelivery(migrationId,{...delivery,environmentId:accepted.environment.environmentId});
      }catch(error){
        if(accepted.created){
          const referenced=(await this.migrations.list()).some(project=>project.runtimeDelivery?.environmentId===accepted.environment.environmentId
            ||Object.values(project.runtimeDeliveries??{}).some(binding=>binding.environmentId===accepted.environment.environmentId));
          if(!referenced)await this.environments.rollbackBuilderDelivery(accepted.environment.environmentId,delivery.resultDigest);
        }
        throw error;
      }
      return {status:'ACCEPTED' as const,environment:accepted.environment,capabilities:accepted.capabilities};
    });
  }
}
