import type { MigrationWorkbench } from './useMigrationWorkbench';
export function ReadinessStage({ state }: { state: MigrationWorkbench; }) {
  const { api, task, setStage, setMessage, current, act, disabled } = state;
  if (!task) return null;
  return (
    <section className="stage-section">
      <h3>验证能否运行</h3>
      <p>
        检查 Runtime 是否支持候选工作区装载、服务和容量要求。实际启动和工具调用在联合验收时验证。
      </p>
      <div className="bundle-actions">
        <button
          className="button primary"
          disabled={disabled || !current || !task.configuration}
          onClick={() =>
            void act(async () => {
              const result = await api<{ message: string; }>(
                '/api/migration-tasks/' + task.id + '/runtime-check',
                { method: 'POST', body: '{}' },
              );
              setMessage(result.message);
            })
          }
        >
          检查运行能力
        </button>
        <button
          className="button secondary"
          disabled={!current || !task.configuration}
          onClick={() => setStage(5)}
        >
          进入任务验收
        </button>
      </div>
    </section>
  );
}
