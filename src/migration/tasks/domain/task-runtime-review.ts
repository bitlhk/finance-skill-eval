import { canonicalSha256 } from '../../../shared/json-canonicalization.js';
import { runtimeLauncherCapabilitiesSchema } from '../../../shared/contracts/runtime-launcher.js';
import { runtimeRequirementsIssues, withRequirementsDigest } from '../../../shared/contracts/runtime-builder.js';
import { RUNTIME_CAPABILITIES_SCHEMA_VERSION, RUNTIME_INSTANCE_SCHEMA_VERSION, RUNTIME_EXECUTION_SCHEMA_VERSION, RUNTIME_OBSERVATION_SCHEMA_VERSION } from '../../../shared/contracts/runtime-protocol-versions.js';
import type { BundleTask, TaskRuntimeReview } from './task-model.js';

/** Declared capabilities can be compared; prose requirements are never silently certified. */
export function reviewPlanEnvironment(task: BundleTask, environment: unknown): TaskRuntimeReview {
  const parsed=runtimeLauncherCapabilitiesSchema.safeParse((environment as {capabilities?:unknown})?.capabilities);
  const plan=task.analysis?.plan, items:TaskRuntimeReview['items']=[];
  if (!plan) items.push({name:'方案中的运行要求',status:'UNVERIFIED',reason:'原记录未提供完整的结构化运行要求；启动成功不代表所有依赖均已满足。'});
  else {
    const inputs=task.configuration?.runtimeInputs??{};
    const suppliedInput=(name:string)=>{const value=inputs[name];return Boolean(value&&('value' in value?value.value.trim():value.secretEnv));};
    const groups=task.analysis?.standardization?.configurationGroups??[];
    for(const field of task.analysis?.standardization?.configurationInputs??[]){
      const supplied=suppliedInput(field.name);
      const alternatives=groups.filter(group=>group.alternatives.some(option=>option.includes(field.name)));
      const covered=alternatives.length>0&&alternatives.every(group=>group.alternatives.some(option=>option.every(suppliedInput)));
      items.push({name:field.label,status:!supplied&&field.required?'UNSATISFIED':'UNVERIFIED',reason:supplied?'配置已提供，仍需验证连接和业务调用。':covered?'已填写同组的其他完整配置，本项无需重复提供。':field.description+(field.required?'；请在本页补充。':alternatives.length?'；请按配置组选择一组完整填写。':'；此项可选。')});
    }
    for(const group of groups)if(!group.alternatives.some(option=>option.every(suppliedInput)))items.push({name:group.label,status:'UNSATISFIED',reason:'请任选一组完整填写；不同组的零散配置不能组合替代。'});
    for (const required of plan.requiredCapabilities) {
      if(!parsed.success) { items.push({name:required.name,status:'UNVERIFIED',reason:'环境未提供可核对的能力说明。'});continue; }
      const caps=parsed.data;
      const requirements=withRequirementsDigest({schemaVersion:'finance.runtime-build-requirements.v3',requestId:'plan-runtime-review',
        target:{runtimeType:caps.runtime.type,protocols:{capabilities:RUNTIME_CAPABILITIES_SCHEMA_VERSION,instance:RUNTIME_INSTANCE_SCHEMA_VERSION,execution:RUNTIME_EXECUTION_SCHEMA_VERSION,observation:RUNTIME_OBSERVATION_SCHEMA_VERSION}},
        executionRequirements:{platform:caps.platform,features:[],limits:{maxSkills:1,maxFiles:1,maxArchiveBytes:1,maxTimeoutMs:task.configuration!.timeoutMs}},requiredCapabilities:[{...required,required:true}]});
      const issues=runtimeRequirementsIssues(requirements,caps);
      items.push({name:required.name,status:issues.length?(required.required?'UNSATISFIED':'UNVERIFIED'):'SATISFIED',reason:issues.length?(required.required?'已登记能力与方案要求不一致或缺失。':'此可选能力尚未确认可用。'):'能力接口、约束与方案要求一致；实际调用仍需验证。'});
    }
    for(const dep of plan.dependencies) {
      const matched=plan.requiredCapabilities.find(item=>item.id===dep.key);
      if(matched) continue;
      items.push({name:dep.name,status:'UNVERIFIED',reason:dep.contract+'；'+dep.configuration});
    }
    for(const condition of plan.conditions) items.push({name:condition,status:'UNVERIFIED',reason:'此运行条件需通过实际调用或外部证据核验，不能仅凭环境登记确认。'});
    if(!items.length) items.push({name:'运行环境连接与启动协议',status:parsed.success?'SATISFIED':'UNVERIFIED',reason:parsed.success?'环境已返回有效协议说明；实例启动及业务效果需继续验证。':'环境未提供可核对的协议说明。'});
  }
  return {candidateId:task.currentCandidateId!,configurationDigest:canonicalSha256(task.configuration),planDigest:task.analysis?canonicalSha256(task.analysis):undefined,
    runtimeSelectionRevision:task.runtimeSelectionRevision,checkedAt:new Date().toISOString(),environmentDigest:canonicalSha256(environment),
    status:items.some(i=>i.status==='UNSATISFIED')?'FAILED':items.some(i=>i.status==='UNVERIFIED')?'INCOMPLETE':'PASSED',items};
}
