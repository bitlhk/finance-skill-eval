import type {BundleTask} from "../../../../contracts/platform/responses";
import type {MigrationApi} from './useMigrationTask';

const instructions={
  diagnose:'请结合任务目标调查现有 Skill、工具和工程，按需读取迁移指导，说明业务边界、工具方案、运行条件和验证思路，并将迁移方案保存为工作产物。此轮先调查和沟通，不修改交付文件；只有确实需要我决定或补充时才询问。',
  implement:'请结合任务目标、现有工程和工作产物中的迁移方案实施必要改造，自行选择合适的 Skill 和工具，并按需运行基础检查。明确已完成与尚未验证的内容；需要实际效果评测或独立审查时使用现有能力，不将未验证的结果称为通过。',
} as const;

/** Both page actions continue the same persistent Agent conversation. */
export async function requestMigrationWork(api:MigrationApi,taskId:string,key:string,action:keyof typeof instructions):Promise<BundleTask|undefined>{
  const response=await api<{task?:BundleTask}>(`/api/migration-tasks/${encodeURIComponent(taskId)}/conversation/message`,{
    method:'POST',body:JSON.stringify({key,text:instructions[action]})});
  return response.task;
}

/** Send refinements to the same Agent and preserve the prior plan as history. */
export async function clarifyMigrationPlan(api:MigrationApi,taskId:string,key:string,clarification:string):Promise<BundleTask|undefined>{
  const response=await api<{task?:BundleTask}>(`/api/migration-tasks/${encodeURIComponent(taskId)}/conversation/message`,{
    method:'POST',body:JSON.stringify({key,text:`请结合已有方案和任务目标处理以下补充要求，并在工作产物中更新迁移方案；保留需要用户决定的问题：\n${clarification}`})});
  return response.task;
}
