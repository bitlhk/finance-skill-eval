import type {BundleTask} from "../../../../contracts/platform/responses";
import type {MigrationApi} from './useMigrationTask';

/** Ask the persistent task Agent to address the review bound to the current files. */
export async function startReviewRepair(api:MigrationApi,taskId:string,key:string):Promise<BundleTask|undefined>{
  const result=await api<{task?:BundleTask}>(`/api/migration-tasks/${encodeURIComponent(taskId)}/conversation/message`,{
    method:'POST',body:JSON.stringify({key,text:'请查看任务材料中当前文件版本的标准化审查意见，结合源码和任务目标核实问题并实施必要修复。修复后请按需请求独立源码审查和实际测试；旧审查不证明修改后的文件已经通过。'})});
  return result.task;
}
