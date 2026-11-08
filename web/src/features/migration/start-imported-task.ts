import type {BundleTask} from "../../../../contracts/platform/responses";
import type {MigrationApi} from './useMigrationTask';

/** Start the existing task once; the main Agent decides its own next steps. */
export async function startImportedTask(api:MigrationApi,task:BundleTask,key:string,notes=''):Promise<BundleTask|undefined>{
  const root='/api/migration-tasks/'+encodeURIComponent(task.id);
  const response=await api<{task?:BundleTask}>(root+'/conversation/message',{
    method:'POST',body:JSON.stringify({key,...(task.inputKind==='agent_project'?{prepareProject:true}:{}),
      text:task.inputKind==='agent_project'
        ?'请先阅读完整 Agent 工程，识别 Skill、工具、运行入口和依赖，按需准备原工程的独立运行副本，说明基线运行方法与尚缺条件。此轮先完成工程准备，不发起效果评测；只有需要我决定或补充时才询问。'+(notes.trim()?' 用户补充：'+notes.trim():'')
        :'请开始迁移任务，先了解已导入的 Skill、工具和任务目标，建立计划并按需推进；只有需要我决定或补充时再询问。'})});
  return response.task;
}
