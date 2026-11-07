import type { MigrationWorkbench } from './useMigrationWorkbench';
import { ProjectBaseline } from './ProjectBaseline';
import {startImportedTask} from './start-imported-task';
export function InputStage({ state }: { state: MigrationWorkbench; }) {
  const { task, setStage } = state;
  if (!task) return null;
  return (
    <section className="migration-stage">
      <div className="migration-stage-heading"><div><h3>{task.inputKind === 'agent_project' ? '已导入的 Agent 工程' : '已导入的 Skill'}</h3><p>{task.goal}</p></div></div>
      {task.inputKind === 'agent_project' && <>
        {task.projectNotes && <p>工程说明：{task.projectNotes}</p>}
        <p>Agent 会阅读启动与加载代码，识别实际使用的 Skill，并做必要的运行适配。正式业务结果见下方基线评测。</p>
        <button className="button primary" disabled={state.disabled || Boolean(task.currentCandidateId)} onClick={() => void state.act(async()=>{
          const next=await startImportedTask(state.api,task,crypto.randomUUID(),state.projectNotes);
          if(next)state.setTask(next);
        })}>理解工程并准备运行</button>
        <label>补充运行信息（选填）<textarea value={state.projectNotes} maxLength={4000} onChange={event => state.setProjectNotes(event.target.value)} placeholder="补充缺少的启动方式或依赖说明后，可以继续准备。请勿填写密钥。"/></label>
        {task.preparations?.map(preparation => <article className="diagnostic-finding" key={preparation.id}>
          <h4>工程准备记录</h4><p>{preparation.report.summary}</p>
          {preparation.report.skills.map(skill => <p key={skill.path}><code>{skill.path}</code>：{skill.usage}</p>)}
          {preparation.report.entrypoints.map((entry,i) => <p key={i}>{entry}</p>)}
          {preparation.report.missing.map((gap,i) => <p key={i}>待补充：{gap}</p>)}
          <p>基线计划：{preparation.report.baselinePlan}</p>
          <p>以下命令回执仅说明运行准备情况，业务结果以正式基线评测为准。</p>
          {preparation.executions.map((execution,i) => <details key={i}><summary>{execution.command.join(' ')} · {{COMPLETED:'命令完成',FAILED:'执行失败',UNAVAILABLE:'环境未就绪',TIMEOUT:'执行超时'}[execution.status]}</summary>
            {execution.snapshotDigest !== preparation.digest && <p>执行后文件有变化，这条回执不能验证最终准备版本。</p>}<pre>{execution.output}</pre></details>)}
        </article>)}
      </>}
      {task.inputKind === 'agent_project' && <ProjectBaseline key={task.id} state={state}/>}
      <details><summary>迁移要求</summary><p>{task.target}</p></details>
      {task.source.members.map((member) => (
        <div className="bundle-task-row" key={member.id}>
          <strong>{member.skillId}</strong>
          <details><summary>文件位置</summary><code>{member.skillFile}</code></details>
        </div>
      ))}
      <button className="button primary" onClick={() => setStage(1)}>
        诊断与迁移方案
      </button>
    </section>
  );
}
