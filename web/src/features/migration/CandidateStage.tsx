import {MarkdownContent} from '../../MarkdownContent';
import type { MigrationWorkbench } from './useMigrationWorkbench';
export function CandidateStage({ state }: { state: MigrationWorkbench; }) {
  const { task, stage, setStage, preview, current, act, start, showFile, disabled } = state;
  if (!task) return null;
  return (
    <section className="migration-stage">
      <div className="migration-stage-heading"><div><h3>迁移结果</h3><p>根据诊断方案生成迁移后的 Skill 与工具，随后检查运行情况和实际效果。</p></div></div>
      {current && (
        <>
          <section className="stage-section restored-plan"><h4>本轮迁移说明</h4>
            <p>已生成 {current.members.length} 个 Skill{current.tools?.length?`、${current.tools.length} 个工具`:''}的迁移结果。请核对文件变化与检查结果，再准备运行环境。</p>
            <details className="stage-detail"><summary>查看完整迁移说明</summary><MarkdownContent compact content={current.summary}/></details>
          </section>
          {task.candidatePlanCurrent===false&&<p role="alert">方案已更新，此结果对应旧方案。请确认新方案后重新生成；旧结果仍可查看。</p>}
          <div className="bundle-task-row">
            <span>
              {current.members.length} 个 Skill · {current.diff.length} 个文件变化
            </span>
            <span>文件检查已通过，实际效果尚需验证</span>
          </div>
          <details className="stage-detail"><summary>查看文件变化（{current.diff.length}）</summary>
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
          </details>
          <details>
            <summary>版本历史（{task.candidates.length}）</summary>
            {task.candidates.map((c, index) => (
              <details key={c.id} className="stage-detail restored-plan">
                <summary>r{index + 1} · {c.createdAt} · {c.id===task.currentCandidateId?'当前结果':'历史结果'}</summary>
                <MarkdownContent compact content={c.summary}/>
              </details>
            ))}
          </details>
          {current.conformance&&<details className="stage-detail" open={current.conformance.issues.length>0||current.conformance.checks.some(c=>c.status!=='CONFORMING')}><summary>标准化审查（{current.conformance.checks.filter(c=>c.status==='CONFORMING').length}/{current.conformance.checks.length} 项符合方案）</summary>
            <ul>{current.conformance.checks.map(c=><li key={c.requirementId}>{c.status==='CONFORMING'?'符合方案':c.status==='NEEDS_CHANGES'?'需要修复':'尚未确认'}：{c.reason}</li>)}{current.conformance.issues.map((issue,i)=><li key={'issue-'+i}>{issue}</li>)}</ul>
            {(current.conformance.issues.length>0||current.conformance.checks.some(c=>c.status!=='CONFORMING'))&&<button className="button secondary" disabled={disabled} onClick={()=>void act(()=>start('repair'))}>根据审查修复</button>}
            <p>源码审查不代表运行验证通过。</p>
          </details>}
          {!!current.contractEvidence?.length&&<details className="stage-detail"><summary>工具独立调用检查</summary><ul>{current.contractEvidence.map(c=><li key={c.toolId}>{task.analysis?.diagnosis?.tools.find(t=>t.id===c.toolId)?.name??c.toolId}：{c.passed&&c.callExecuted?'已实际调用':'尚未验证通过'} · {c.detail}</li>)}</ul></details>}
        </>
      )}
      <div className="bundle-actions">
        <button
          className={current ? "button secondary" : "button primary"}
          disabled={disabled || !task.planApproved || !task.analysis || Boolean(task.analysis.missing.length)}
          onClick={() => void act(() => start('generate'))}
        >
          {current ? '重新生成' : '生成迁移结果'}
        </button>
        {current && task.candidatePlanCurrent !== false && (
          <button className="button primary" onClick={() => setStage(3)}>
            下一步：准备运行环境
          </button>
        )}
      </div>
    </section>
  );
}
