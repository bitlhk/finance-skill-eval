import '../../migration.css';
import { MigrationActivity } from '../../MigrationActivity';
import { useMigrationWorkbench } from './useMigrationWorkbench';
import { statusLabels } from './presentation';
import { MigrationProgress } from './MigrationProgress';
import '../../bundle-migration.css';
import { InputStage } from './InputStage';
import { DiagnosisStage } from './DiagnosisStage';
import { CandidateStage } from './CandidateStage';
import { RuntimeStage } from './RuntimeStage';
import { ReadinessStage } from './ReadinessStage';
import { AcceptanceStage } from './AcceptanceStage';
import { ExportStage } from './ExportStage';
import { TaskList, TaskEntry } from './TaskList';
export function MigrationTaskPanel(props: Parameters<typeof useMigrationWorkbench>[0]) {
  const state = useMigrationWorkbench(props);
  const { listView, setListView, pollError, task, setTask, stage, setStage, busy, error, message, current, active, latestAttempt, run, list, act, post } = state;
  if (listView) return <section className="migration-panel bundle-panel">
    <header><div><h2>Skill 迁移</h2><p>诊断 Skill 与工具依赖，生成迁移结果，并验证实际效果。</p></div>
      <div>{task && <button className="button secondary" onClick={() => setListView(false)}>返回当前迁移</button>}
      <button className="button primary" disabled={busy} onClick={state.newTask}>新建迁移</button></div>
    </header>
    {(error || pollError) && <p role="alert">{error || pollError}</p>}
    <TaskList state={state}/>
  </section>;
  return (
    <section className="migration-panel bundle-panel">
      <button className="button secondary" disabled={busy} onClick={() => void act(async () => { await list(); setListView(true); })}>返回迁移列表</button>
      <header><div><h2>{task?.name ?? '新建迁移'}</h2><p>{task ? task.source.members.map(member => member.skillId).join(' · ') : '上传要迁移的完整工程'}</p></div></header>
      <MigrationProgress task={task} stage={stage} onSelect={setStage} checkingRuntime={state.checkingRuntime}/>
      {pollError && <p role="alert">{pollError}</p>}
      {task && error && (
        <p role="alert" className="bundle-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {task&&stage<=1&&task.source.members.some(member=>member.sourceWarnings?.length)&&<details className="stage-detail"><summary>导入时发现需要修正的格式问题</summary><ul>{task.source.members.flatMap(member=>(member.sourceWarnings??[]).map((warning,i)=><li key={member.id+i}>{member.skillFile}：{warning}</li>))}</ul><p>原工程已完整保留，这些问题会交给迁移诊断处理。</p></details>}
      {task && ['PENDING', 'STALE'].includes(task.builderStatus ?? '') && <p className="bundle-notice">
        {task.builderStatus === 'STALE' ? '运行环境需要重新确认。' : '运行环境尚未准备好。'}请在“准备运行环境”中完成配置后再验证。
      </p>}
      {task && active && <MigrationActivity key={`${task.id}:${active.id}`} projectId={task.id} attempt={active}/>}
      {!active && latestAttempt?.error && (
        <p className="bundle-notice">
          {statusLabels[latestAttempt.status]}：{latestAttempt.error}
        </p>
      )}
      {!task && <TaskEntry state={state} />}
      {task && stage === 0 && <InputStage state={state} />}
      {task && stage === 1 && <DiagnosisStage state={state} />}
      {task && stage === 2 && <CandidateStage state={state} />}
      {task && stage === 3 && <RuntimeStage state={state} />}
      {task && stage === 4 && <ReadinessStage state={state} />}
      {task && stage === 5 && <AcceptanceStage state={state} />}
      {task && stage === 6 && <ExportStage state={state} />}
      {task && !active && <details className="stage-detail"><summary>执行过程</summary><MigrationActivity key={task.id} projectId={task.id}/></details>}
      {task && <details className="stage-section"><summary>排查详情</summary>
        <p>任务：<code>{task.id}</code></p><p>创建请求：<code>{task.requestId ?? '未采集'}</code></p>
        {latestAttempt && <><p>尝试：<code>{latestAttempt.id}</code></p><p>请求：<code>{latestAttempt.requestId ?? '未采集'}</code></p><p>Agent：<code>{latestAttempt.agentRunId ?? (latestAttempt.kind === 'ACCEPT' ? '本操作不调用迁移 Agent' : '未采集')}</code></p></>}
        {run && <p>验收运行：<code>{run.id}</code></p>}
        {task.attempts.length > 0 && <details><summary>操作历史与关联 ID（{task.attempts.length}）</summary>
          {[...task.attempts].reverse().map(attempt => <article key={attempt.id} className="stage-section">
            <strong>{({ BASELINE:'原工程基线评测',PREPARE: '工程运行准备', ANALYZE: '诊断', GENERATE: '生成', REPAIR: '修复', ACCEPT: '验收',OPTIMIZE:'优化' })[attempt.kind]} · {statusLabels[attempt.status]}</strong>
            <p>{attempt.startedAt} · <code>{attempt.id}</code></p>
            <p>请求：<code>{attempt.requestId ?? '未采集'}</code></p>
            {attempt.agentRunId && <p>Agent：<code>{attempt.agentRunId}</code></p>}
            {attempt.runId && <p>{attempt.kind === 'REPAIR' ? '修复依据运行' : '验收运行'}：<code>{attempt.runId}</code></p>}
          </article>)}
        </details>}
      </details>}
    </section>
  );
}
