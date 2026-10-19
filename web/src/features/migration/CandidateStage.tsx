import type { MigrationWorkbench } from './useMigrationWorkbench';
export function CandidateStage({ state }: { state: MigrationWorkbench; }) {
  const { task, stage, setStage, preview, current, act, start, showFile, disabled } = state;
  if (!task) return null;
  return (
    <section className="stage-section">
      <h3>迁移结果</h3>
      <p>同一个 Agent 可以跨 Skill 修改，未变化的成员随整组候选保留。</p>
      {current && (
        <>
          <p className="bundle-summary">{current.summary}</p>
          <div className="bundle-task-row">
            <span>
              {current.members.length} 个成员 · {current.diff.length} 个文件变化
            </span>
            <span>静态清单检查通过；实际效果由联合验收确认</span>
          </div>
          {current.diff.map((file) => (
            <div className="bundle-task-row" key={file.path}>
              <span>
                {file.kind === 'ADDED' ? '新增' : file.kind === 'REMOVED' ? '移除' : '修改'} ·{' '}
                <code>{file.path}</code>
              </span>
              <button className="button secondary" onClick={() => void act(() => showFile(file.path))}>
                查看差异
              </button>
            </div>
          ))}
          {preview && (
            <details open>
              <summary>{preview.path}</summary>
              <div className="bundle-file-diff">
                <pre>{preview.before}</pre>
                <pre>{preview.after}</pre>
              </div>
            </details>
          )}
          <details>
            <summary>候选历史（{task.candidates.length}）</summary>
            {task.candidates.map((c, index) => (
              <p key={c.id}>
                r{index + 1} · {c.summary} · {c.createdAt}
              </p>
            ))}
          </details>
        </>
      )}
      <div className="bundle-actions">
        <button
          className="button primary"
          disabled={disabled || !task.analysis || Boolean(task.analysis.missing.length)}
          onClick={() => void act(() => start('generate'))}
        >
          {current ? '继续整体改造' : '生成迁移结果'}
        </button>
        {current && (
          <button className="button secondary" onClick={() => setStage(3)}>
            Runtime 适配与登记
          </button>
        )}
      </div>
    </section>
  );
}
