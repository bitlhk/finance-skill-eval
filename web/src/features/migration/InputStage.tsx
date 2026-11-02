import type { MigrationWorkbench } from './useMigrationWorkbench';
export function InputStage({ state }: { state: MigrationWorkbench; }) {
  const { task, setStage } = state;
  if (!task) return null;
  return (
    <section className="migration-stage">
      <div className="migration-stage-heading"><div><h3>已导入的 Skill</h3><p>{task.goal}</p></div></div>
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
