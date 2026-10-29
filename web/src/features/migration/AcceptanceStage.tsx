import type { MigrationWorkbench } from './useMigrationWorkbench';
import type { BundleTask } from '../../../../src/migration/tasks/domain/task-model';
import { statusLabels } from './presentation';
import { MigrationRunView } from './MigrationRunView';
export function AcceptanceStage({ state }: { state: MigrationWorkbench; }) {
  const { api, task, setTask, setStage, setMessage, suite, setSuite, setRunId, current, run, act, start, disabled } = state;
  if (!task) return null;
  const builderBlocked = ['PENDING', 'STALE'].includes(task.builderStatus ?? '');
  return (
    <section className="stage-section">
      <h3>联合验收</h3>
      <p>加载全部 Skill，由 Agent 按业务需要协作。开发回归反馈可用于修复；独立留出案例不反馈给迁移 Agent。</p>
      <label>
        验收测试集 JSON
        <textarea
          aria-label="验收测试集 JSON"
          className="bundle-suite"
          value={suite}
          onChange={(e) => setSuite(e.target.value)}
          spellCheck={false}
        />
      </label>
      <div className="bundle-actions">
        <button
          className="button secondary"
          disabled={disabled}
          onClick={() =>
            void act(async () => {
              setTask(
                await api<BundleTask>('/api/migration-tasks/' + task.id + '/suite', {
                  method: 'PUT',
                  body: JSON.stringify(JSON.parse(suite)),
                }),
              );
              setMessage('验收测试集已保存');
            })
          }
        >
          保存测试集
        </button>
        <button
          className="button primary"
          disabled={disabled || builderBlocked || !current || !task.suite || !task.configuration}
          onClick={() =>
            void act(async () => {
              setRunId('');
              await start('acceptance', { phase: 'development' });
            })
          }
        >
          开始联合验收
        </button>
        {Boolean(task.suite?.holdoutCases?.length) && (
          <button
            className="button secondary"
            disabled={disabled || builderBlocked || !current || !task.configuration}
            onClick={() =>
              void act(async () => {
                setRunId('');
                await start('acceptance', { phase: 'holdout' });
              })
            }
          >
            执行独立留出验收
          </button>
        )}
      </div>
      {task.runs.length > 0 && (
        <label>
          运行记录
          <select aria-label="运行记录" value={run?.id ?? ''} onChange={(e) => setRunId(e.target.value)}>
            {[...task.runs].reverse().map((r) => (
              <option key={r.id} value={r.id}>
                {r.createdAt} · {r.phase === 'holdout' ? '留出' : '开发'} · {statusLabels[r.status]}
              </option>
            ))}
          </select>
        </label>
      )}
      {run && (
        <MigrationRunView
          run={run}
          currentCandidateId={task.currentCandidateId}
          configurationMatches={
            JSON.stringify(run.configuration) === JSON.stringify(task.configuration) &&
            JSON.stringify(run.suite) === JSON.stringify(task.suite) &&
            run.judgeDigest === task.currentJudgeDigest &&
            run.runtimeSelectionRevision === task.runtimeSelectionRevision &&
            run.builderBindingId === (task.selectedRuntimeBuildRequestId ? task.runtimeDelivery?.id : undefined)
          }
        />
      )}
      {run?.status==='INCOMPLETE' && <p role="status">验收未完成，请先检查运行环境或评审服务；已取得的执行证据会保留。</p>}
      {run &&
        run.candidateId === task.currentCandidateId &&
        ['FAILED', 'INCOMPLETE'].includes(run.status) &&
        !run.cases.some(c=>c.failureStage==='JUDGE' || c.failureStage==='RUNTIME') &&
        run.phase === 'development' && (
          <button
            className="button primary"
            disabled={disabled}
            onClick={() =>
              void act(async () => {
                await start('repair', { runId: run.id });
                setStage(2);
              })
            }
          >
            让 Agent 查看工程并修复
          </button>
        )}
      <div className="bundle-actions">
        <button className="button secondary" disabled={!current} onClick={() => setStage(6)}>
          查看交付内容
        </button>
      </div>
    </section>
  );
}
