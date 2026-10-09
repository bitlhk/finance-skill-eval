import {expect,it} from 'vitest';
import {RuntimeDeliveryCoordinator} from '../src/service/runtime-delivery-coordinator.js';
import {withResultDigest} from '../src/shared/contracts/runtime-builder.js';
import {RUNTIME_CAPABILITIES_SCHEMA_VERSION,RUNTIME_EXECUTION_SCHEMA_VERSION,RUNTIME_INSTANCE_SCHEMA_VERSION,RUNTIME_OBSERVATION_SCHEMA_VERSION} from '../src/shared/contracts/runtime-protocol-versions.js';

function result(){
  return withResultDigest({schemaVersion:'finance.runtime-build-result.v1',buildId:'build',requestId:'request',requirementsDigest:'a'.repeat(64),status:'SUCCEEDED',
    builder:{name:'builder',version:'1'},launcher:{schemaVersion:'finance.runtime-launcher-descriptor.v1',deploymentId:'shared-deployment',baseUrl:'http://127.0.0.1:9000/',runtime:{type:'openjiuwen',version:'1'},
      protocols:{capabilities:RUNTIME_CAPABILITIES_SCHEMA_VERSION,instance:RUNTIME_INSTANCE_SCHEMA_VERSION,execution:RUNTIME_EXECUTION_SCHEMA_VERSION,observation:RUNTIME_OBSERVATION_SCHEMA_VERSION},authentication:{type:'none'},artifactSha256:'b'.repeat(64),capabilitiesDigest:'c'.repeat(64),expiresAt:null},
    capabilityResults:[],verifications:[],errors:[],builtAt:new Date().toISOString()});
}

it('serializes one deployment so a failed binding cannot delete another request result',async()=>{
  let environmentExists=false,rollbackCount=0;const order:string[]=[];
  const delivery={schemaVersion:'finance.runtime-launcher-delivery-record.v1' as const,buildId:'build',requestId:'request',deploymentId:'shared-deployment',artifactSha256:'b'.repeat(64),capabilitiesDigest:'c'.repeat(64),resultDigest:result().resultDigest,builder:{name:'builder',version:'1'},acceptedAt:new Date().toISOString(),expiresAt:null,
    evalConformance:{status:'PASSED' as const,testedAt:new Date().toISOString(),checks:['capabilities','create','status','execute','evidence','delete'] as const}};
  const environments={acceptBuilderDelivery:async()=>{const created=!environmentExists;environmentExists=true;order.push(`accept:${created}`);return {created,environment:{environmentId:'env-shared',type:'runtime_launcher' as const,delivery},capabilities:{}};},
    rollbackBuilderDelivery:async()=>{rollbackCount+=1;environmentExists=false;order.push('rollback');}};
  const projects=new Map<string,{runtimeDelivery?:{environmentId:string}}>([['fail',{}],['ok',{}]]);
  const migrations={conformanceCandidate:async()=>({skill:{},requiredTools:[]}),runtimeRequirements:async()=>({requestId:'request'}),list:async()=>[...projects.values()],bindRuntimeDelivery:async(id:string,input:{environmentId:string})=>{
    order.push(`bind:${id}`);if(id==='fail')throw new Error('save failed');projects.get(id)!.runtimeDelivery=input;
  }};
  const coordinator=new RuntimeDeliveryCoordinator(migrations as never,environments as never);
  const failed=coordinator.acceptAndBind('fail',{result:result(),trustReference:'local'});
  const succeeded=coordinator.acceptAndBind('ok',{result:result(),trustReference:'local'});
  await expect(failed).rejects.toThrow('save failed');await expect(succeeded).resolves.toMatchObject({status:'ACCEPTED'});
  expect(order).toEqual(['accept:true','bind:fail','rollback','accept:true','bind:ok']);
  expect(environmentExists).toBe(true);expect(rollbackCount).toBe(1);expect(projects.get('ok')?.runtimeDelivery?.environmentId).toBe('env-shared');
});
