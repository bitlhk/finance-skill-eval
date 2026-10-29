import type { MigrationWorkbench } from './useMigrationWorkbench';
export function InputStage({ state }: { state: MigrationWorkbench; }) {
  const { task, setStage } = state;
  if (!task) return null;
  return (
    <section className="stage-section">
      <h3>任务输入</h3>
      <p>{task.goal}</p>
      <p>目标：{task.target}</p>
      {task.source.members.map((member) => (
        <div className="bundle-task-row" key={member.id}>
          <strong>{member.skillId}</strong>
          <code>{member.skillFile}</code>
        </div>
      ))}
      <button className="button primary" onClick={() => setStage(1)}>
        诊断与迁移方案
      </button>
    </section>
  );
}
