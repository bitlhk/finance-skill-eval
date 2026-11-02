import type { MigrationWorkbench } from './useMigrationWorkbench';
import type { BundleTask } from '../../../../src/migration/tasks/domain/task-model';
export function ReadinessStage({ state }: { state: MigrationWorkbench; }) {
  const { api, task, setTask, setStage, setMessage, current, act, disabled, setCheckingRuntime } = state;
  if (!task) return null;
  return (
    <section className="migration-stage">
      <div className="migration-stage-heading"><div><h3>验证能否运行</h3><p>
        检查运行环境能否启动并加载 Skill。业务工具和结果将在下一步验证。
      </p></div></div>
      <div className="bundle-actions">
        <button
          className="button primary"
          disabled={disabled || !current || !task.configuration || task.candidatePlanCurrent===false || task.runtimeReviewCurrent && task.runtimeReview?.status==='FAILED'}
          onClick={() =>
            void act(async () => {
              setCheckingRuntime(true);
              try {
                const result = await api<{ message: string; }>(
                  '/api/migration-tasks/' + task.id + '/runtime-check',
                  { method: 'POST', body: '{}' },
                );
                setMessage(result.message);
              } finally {
                setCheckingRuntime(false);
                setTask(await api<BundleTask>('/api/migration-tasks/' + task.id));
              }
            })
          }
        >
          执行启动检查
        </button>
        <button
          className="button secondary"
          disabled={!current || !task.configuration || task.candidatePlanCurrent===false || task.runtimeReviewCurrent && task.runtimeReview?.status==='FAILED'}
          onClick={() => setStage(5)}
        >
          下一步：验证实际效果
        </button>
      </div>
      {task.startupCheck && <p role="status">{task.startupCheckCurrent ? task.startupCheck.message : '迁移结果或环境配置已变化，需要重新执行启动检查。'}</p>}
    </section>
  );
}
