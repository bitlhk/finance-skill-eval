import type { MigrationWorkbench } from './useMigrationWorkbench';
export function DiagnosisStage({ state }: { state: MigrationWorkbench; }) {
  const { task, setStage, act, start, disabled } = state;
  if (!task) return null;
  return (
    <section className="stage-section">
      <h3>诊断与迁移方案</h3>
      <p>Agent 会查看全部 Skill、共享源码和已有调度配置，识别需要共同调整的内容。</p>
      {task.analysis && (
        <>
          <p className="bundle-summary">{task.analysis.summary}</p>
          {task.analysis.changes.map((change, index) => (
            <div className="bundle-task-row" key={index}>
              <div>
                <p>{change.reason}</p>
                <small>{change.paths.join('、')}</small>
              </div>
            </div>
          ))}
          {task.analysis.missing.length > 0 && (
            <p className="bundle-error">
              待补充：{task.analysis.missing.join('；')}。请补齐源工程后重新导入。
            </p>
          )}
        </>
      )}
      <div className="bundle-actions">
        <button
          className="button primary"
          disabled={disabled}
          onClick={() => void act(() => start('analysis'))}
        >
          {task.analysis ? '重新分析' : '分析 Skill 工程'}
        </button>
        {task.analysis && !task.analysis.missing.length && (
          <button className="button secondary" onClick={() => setStage(2)}>
            查看与执行改造
          </button>
        )}
      </div>
    </section>
  );
}
