import { useMigrationWorkbench } from './useMigrationWorkbench';
import { stages, statusLabels } from './presentation';
import '../../bundle-migration.css';
import { InputStage } from './InputStage';
import { DiagnosisStage } from './DiagnosisStage';
import { CandidateStage } from './CandidateStage';
import { RuntimeStage } from './RuntimeStage';
import { ReadinessStage } from './ReadinessStage';
import { AcceptanceStage } from './AcceptanceStage';
import { ExportStage } from './ExportStage';
import { TaskList } from './TaskList';
export function MigrationTaskPanel(props: Parameters<typeof useMigrationWorkbench>[0]) {
  const state = useMigrationWorkbench(props);
  const { pollError, task, setTask, stage, setStage, busy, error, message, current, active, latestAttempt, run, list, act, post } = state;
  return (
    <section className="migration-panel bundle-panel">
      <header className="bundle-heading">
        <div>
          <h2>{task?.name ?? '迁移任务'}</h2>
          <p>
            {task
              ? task.source.members.length +
              ' 个 Skill · 同一个 Agent 工作区 · ' +
              (current ? '整组候选 r' + task.candidates.length : '尚未生成候选')
              : '导入 1–10 个 Skill 和相关源码，在同一任务内完成迁移与验收。'}
          </p>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              setTask(null);
              setStage(0);
              await list();
            })
          }
        >
          任务列表 / 新建
        </button>
      </header>
      {pollError && <p role="alert">{pollError}</p>}
      {error && (
        <p role="alert" className="bundle-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {task && ['PENDING', 'STALE'].includes(task.builderStatus ?? '') && <p className="bundle-notice">
        {task.builderStatus === 'STALE' ? 'Builder 绑定已失效。' : '正在等待 Builder 交付。'}请在 Runtime 适配与登记中完成绑定，或明确切换为已有环境后再验收。
      </p>}
      {task && (
        <nav aria-label="迁移步骤">
          {stages.map((label, index) => (
            <button
              key={label}
              className={stage === index ? 'active' : ''}
              aria-current={stage === index ? 'step' : undefined}
              onClick={() => setStage(index)}
            >
              <span>{index + 1}</span> {label}
            </button>
          ))}
        </nav>
      )}
      {task && <details className="stage-section"><summary>任务与排障标识</summary>
        <p>任务：<code>{task.id}</code></p><p>创建请求：<code>{task.requestId ?? '旧记录未采集'}</code></p>
        {task.origin && <p>来源旧任务：<code>{task.origin.projectId}</code> · 已重新开始验收，旧结论未继承</p>}
        {latestAttempt && <><p>尝试：<code>{latestAttempt.id}</code></p><p>请求：<code>{latestAttempt.requestId ?? '旧记录未采集'}</code></p><p>Agent：<code>{latestAttempt.agentRunId ?? (latestAttempt.kind === 'ACCEPT' ? '本操作不调用迁移 Agent' : '旧记录未采集')}</code></p></>}
        {run && <p>验收运行：<code>{run.id}</code></p>}
        {task.attempts.length > 0 && <details><summary>操作历史与关联 ID（{task.attempts.length}）</summary>
          {[...task.attempts].reverse().map(attempt => <article key={attempt.id} className="stage-section">
            <strong>{({ ANALYZE: '诊断', GENERATE: '生成', REPAIR: '修复', ACCEPT: '验收' })[attempt.kind]} · {statusLabels[attempt.status]}</strong>
            <p>{attempt.startedAt} · <code>{attempt.id}</code></p>
            <p>请求：<code>{attempt.requestId ?? '旧记录未采集'}</code></p>
            {attempt.agentRunId && <p>Agent：<code>{attempt.agentRunId}</code></p>}
            {attempt.runId && <p>{attempt.kind === 'REPAIR' ? '修复依据运行' : '验收运行'}：<code>{attempt.runId}</code></p>}
          </article>)}
        </details>}
      </details>}
      {active && (
        <div className="bundle-notice" role="status">
          {active.message}
          <button
            className="button secondary"
            onClick={() => void act(async () => setTask(await post('/cancel', {})))}
          >
            取消当前操作
          </button>
        </div>
      )}
      {!active && latestAttempt?.error && (
        <p className="bundle-notice">
          {statusLabels[latestAttempt.status]}：{latestAttempt.error}
        </p>
      )}
      {!task && <TaskList state={state} />}
      {task && stage === 0 && <InputStage state={state} />}
      {task && stage === 1 && <DiagnosisStage state={state} />}
      {task && stage === 2 && <CandidateStage state={state} />}
      {task && stage === 3 && <RuntimeStage state={state} />}
      {task && stage === 4 && <ReadinessStage state={state} />}
      {task && stage === 5 && <AcceptanceStage state={state} />}
      {task && stage === 6 && <ExportStage state={state} />}
    </section>
  );
}
