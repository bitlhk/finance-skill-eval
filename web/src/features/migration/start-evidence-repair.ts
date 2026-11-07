import type {BundleTask} from "../../../../contracts/platform/responses";
import type {MigrationApi} from './useMigrationTask';

/** Continue the current task with the selected development evidence. */
export async function startEvidenceRepair(api:MigrationApi,taskId:string,runId:string,key:string):Promise<BundleTask|undefined>{
  const result=await api<{task?:BundleTask}>(`/api/migration-tasks/${encodeURIComponent(taskId)}/conversation/message`,{
    method:'POST',body:JSON.stringify({key,developmentRunId:runId,text:`请查看开发集运行 ${runId} 的实际证据，诊断失败原因，判断需要调整 Skill、工具、工程源码还是运行配置。根据任务目标实施必要修复，使用已配置的开发集复测；运行条件或证据不足时说明原因，不把未完成的验证当作通过。`})});
  return result.task;
}
