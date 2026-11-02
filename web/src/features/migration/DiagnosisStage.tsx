import type { MigrationWorkbench } from './useMigrationWorkbench';
import type { BundleTask } from '../../../../src/migration/tasks/domain/task-model';
import {TaskPlan} from './TaskPlan';
import {DiagnosisDetails} from './DiagnosisDetails';
export function DiagnosisStage({state}:{state:MigrationWorkbench}) {
  const {task,setTask,setStage,api,act,start,disabled}=state;
  if(!task)return null;
  const blocking=Boolean(task.analysis?.missing.length||task.analysis?.plan?.unresolvedQuestions.length);
  return <section className="migration-stage diagnosis-step">
    <div className="migration-stage-heading"><div><h3>诊断与迁移方案</h3><p>核对原有业务、工具和依赖，审阅并确认迁移方案。</p></div></div>
    {task.analysis?<><DiagnosisDetails task={task} busy={disabled} clarify={clarification=>void act(()=>start('analysis',{clarification}))}/><details className="stage-detail" open={blocking}><summary>完整迁移方案与补充说明</summary><TaskPlan key={task.planRevisionId??task.id} task={task} busy={disabled} clarify={clarification=>void act(()=>start('analysis',{clarification}))}/></details></>:<section className="diagnosis-plan"><h3>可复用迁移方案</h3><p>诊断后查看具体改造、运行条件与验收方式，确认后再生成结果。</p></section>}
    {!!task.analysis?.missing.length&&<section role="alert"><h4>确认方案前需要补充</h4><ul>{task.analysis.missing.map((item,index)=><li key={index}>{item}</li>)}</ul></section>}
    <div className="bundle-actions diagnosis-actions">
      <button className={task.analysis?'button secondary':'button primary'} disabled={disabled} onClick={()=>void act(()=>start('analysis'))}>{task.analysis?'重新分析':'开始诊断'}</button>
      {task.analysis&&<button className="button primary" disabled={disabled||blocking} onClick={()=>void act(async()=>{
        if(!task.planApproved)setTask(await api<BundleTask>('/api/migration-tasks/'+task.id+'/plan/approval',{method:'POST',body:JSON.stringify({analysisDigest:task.currentPlanDigest})}));
        setStage(2);
      })}>{task.planApproved?'下一步：生成迁移结果':'确认方案并继续'}</button>}
    </div>
    {(task.planRevisions?.length??0)>1&&<details><summary>历史方案（{task.planRevisions!.length}）</summary>{[...task.planRevisions!].reverse().map(revision=><details key={revision.id}><summary>{revision.createdAt} · {revision.approvedAt?'曾确认':'未确认'}{revision.id===task.planRevisionId?' · 当前方案':''}</summary><TaskPlan task={{...task,analysis:revision.analysis,planRevisionId:revision.id,planApproved:Boolean(revision.approvedAt)}} busy={true}/></details>)}</details>}
  </section>;
}
