import type { MigrationWorkbench } from './useMigrationWorkbench';
import {TaskPlan} from './TaskPlan';
import {DiagnosisDetails} from './DiagnosisDetails';
import {clarifyMigrationPlan,requestMigrationWork} from './request-migration-work';
export function DiagnosisStage({state}:{state:MigrationWorkbench}) {
  const {task,setTask,setStage,api,act,disabled,setMessage}=state;
  if(!task)return null;
  const blocking=Boolean(task.analysis?.missing.length||task.analysis?.plan?.unresolvedQuestions.length);
  const clarify=(value:string)=>void act(async()=>{
    const next=await clarifyMigrationPlan(api,task.id,crypto.randomUUID(),value);if(next)setTask(next);
    setMessage('补充要求已交给主 Agent；更新后的方案显示在工作产物中。');
  });
  return <section className="migration-stage diagnosis-step">
    <div className="migration-stage-heading"><div><h3>诊断与迁移方案</h3><p>核对原有业务、工具和依赖，查看迁移方案。</p></div></div>
    {task.analysis?<><p>下方是已保存的结构化方案；Agent 新的分析显示在任务对话和工作产物中，不会自动覆盖此方案。</p><DiagnosisDetails task={task} busy={disabled} clarify={clarify}/><details className="stage-detail" open={blocking}><summary>完整迁移方案与补充说明</summary><TaskPlan key={task.planRevisionId??task.id} task={task} busy={disabled} clarify={clarify}/></details></>:<section className="diagnosis-plan"><h3>迁移方案</h3><p>Agent 的调查、迁移方案和需要决定的事项会显示在任务对话及工作产物中。</p></section>}
    {!!task.analysis?.missing.length&&<section role="alert"><h4>原方案记录的待核对信息</h4><ul>{task.analysis.missing.map((item,index)=><li key={index}>{item}</li>)}</ul></section>}
    <div className="bundle-actions diagnosis-actions">
      <button className={task.analysis?'button secondary':'button primary'} disabled={disabled} onClick={()=>void act(async()=>{
        const next=await requestMigrationWork(api,task.id,crypto.randomUUID(),'diagnose');if(next)setTask(next);
        setMessage('已交给主 Agent 诊断，方案和进展显示在任务对话及工作产物中。');
      })}>{task.analysis?'让 Agent 重新分析':'开始诊断'}</button>
      <button className={task.analysis?'button primary':'button secondary'} disabled={disabled} onClick={()=>setStage(2)}>下一步：生成迁移结果</button>
    </div>
    {(task.planRevisions?.length??0)>1&&<details><summary>历史方案（{task.planRevisions!.length}）</summary>{[...task.planRevisions!].reverse().map(revision=><details key={revision.id}><summary>{revision.createdAt} · {revision.approvedAt?'曾确认':'未确认'}{revision.id===task.planRevisionId?' · 当前方案':''}</summary><TaskPlan task={{...task,analysis:revision.analysis,planRevisionId:revision.id,planApproved:Boolean(revision.approvedAt)}} busy={true}/></details>)}</details>}
  </section>;
}
