import type { MigrationWorkbench } from './useMigrationWorkbench';
export function ReadinessStage({ state }: { state: MigrationWorkbench; }) {
  const { api, task, setStage, setMessage, current, act, disabled } = state;
  if (!task) return null;
  return (
    <section className="stage-section">
      <h3>启动检查</h3>
      <p>
        创建实例并装载全部 Skill，核对运行配置与容量后释放实例。业务工具执行和结果由联合验收验证。
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
          执行启动检查
        </button>
        <button
          className="button secondary"
          disabled={!current || !task.configuration}
          onClick={() => setStage(5)}
        >
          进入联合验收
        </button>
      </div>
    </section>
  );
}
