import {MarkdownContent} from '../../MarkdownContent';
import type { MigrationWorkbench } from './useMigrationWorkbench';
import {startReviewRepair} from './start-review-repair';
import {requestMigrationWork} from './request-migration-work';
export function CandidateStage({ state }: { state: MigrationWorkbench; }) {
  const { task, stage, setStage, preview, current, act, showFile, disabled,api,setTask,setMessage } = state;
  if (!task) return null;
  return (
    <section className="migration-stage">
      <div className="migration-stage-heading"><div><h3>迁移结果</h3><p>根据诊断方案生成迁移后的 Skill 与工具，随后检查运行情况和实际效果。</p></div></div>
      {current && (
        <>
          <section className="stage-section restored-plan"><h4>本轮迁移说明</h4>
            {current.draft&&<p role="status">这是 Agent 在对话中保存的工作草稿，尚未完成迁移交付和独立验证。</p>}
            <p>{current.draft?'Agent 已保存工作区修改，请继续检查和验证。':`已生成 ${current.members.length} 个 Skill${current.tools?.length?`、${current.tools.length} 个工具`:''}的迁移结果。请核对文件变化与检查结果，再准备运行环境。`}</p>
            <details className="stage-detail"><summary>查看完整迁移说明</summary><MarkdownContent compact content={current.summary}/></details>
          </section>
          {task.candidatePlanCurrent===false&&<p role="alert">方案已更新，此结果对应旧方案。请确认新方案后重新生成；旧结果仍可查看。</p>}
          <div className="bundle-task-row">
            <span>
              {current.members.length} 个 Skill · {current.diff.length} 个文件变化
            </span>
            <span>{current.draft?'工作草稿，尚未完成独立验证':'文件检查已通过，实际效果尚需验证'}</span>
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
            {current.conformance.evaluationDecision&&<p>{current.conformance.evaluationDecision.decision==='PROCEED'?'可以进入运行评测':'需要先修复'}：{current.conformance.evaluationDecision.reason}</p>}
            {(current.conformance.issues.length>0||current.conformance.checks.some(c=>c.status==='NEEDS_CHANGES')||current.conformance.evaluationDecision?.decision==='REVISE')&&<button className="button secondary" disabled={disabled} onClick={()=>void act(async()=>{
              const updated=await startReviewRepair(api,task.id,crypto.randomUUID());
              if(updated)setTask(updated);
              setMessage('已交给主 Agent 核对审查意见，进展显示在任务对话中。');
            })}>根据审查修复</button>}
            <p>尚未确认的要求可通过后续运行评测取证；完成验证前不能视为通过。</p>
          </details>}
          {!!current.contractEvidence?.length&&<details className="stage-detail"><summary>工具独立调用检查</summary><ul>{current.contractEvidence.map(c=><li key={c.toolId}>{task.analysis?.diagnosis?.tools.find(t=>t.id===c.toolId)?.name??c.toolId}：{c.passed&&c.callExecuted?'已实际调用':'尚未验证通过'} · {c.detail}</li>)}</ul></details>}
          {!!task.effectReviews?.filter(review=>review.candidateDigest===current.digest).length&&<details className="stage-detail"><summary>独立效果审查</summary>
            {task.effectReviews.filter(review=>review.candidateDigest===current.digest).map(review=><section key={review.id}>
              {review.configurationCurrent===false&&<p role="status">评测配置已变化，原审查仅供参考。</p>}
              {review.scopeCurrent===false&&<p role="status">任务范围已变化或原范围未记录，原审查仅供参考。</p>}
              <p>审查目标：{review.goal}</p>
              <p>{review.decision.reason}</p>
              <p>{review.assessmentMode==='GOAL'?'按用户目标审查单次结果，不代表相对基线提升。':`基线评测：${review.baselineRunId} · `}当前评测：{review.candidateRunId}</p>
              {review.review.status==='PRODUCED'&&review.assessmentMode!=='GOAL'&&<><p>改善：{review.review.review.improvements.join('；')||'未记录'}</p>
                <p>回退：{review.review.review.regressions.join('；')||'未记录'}</p></>}
              <p>效果审查仅适用于上述评测和文件版本，不代表其他运行条件已验证。</p>
            </section>)}
          </details>}
          {!!current.executions?.length&&<details className="stage-detail"><summary>工程命令执行记录（{current.executions.length}）</summary>
            <p>命令在隔离副本中执行；记录仅说明当时的运行结果，不代表效果评测或最终验收通过。</p>
            {current.executions.map((execution,i)=><details key={i}><summary>{execution.command.join(' ')} · {{COMPLETED:'命令完成',FAILED:'执行失败',UNAVAILABLE:'环境未就绪',TIMEOUT:'执行超时'}[execution.status]}</summary>
              {execution.snapshotDigest!==current.digest&&<p>执行后文件有变化，记录不代表当前结果已通过该命令。</p>}
              <p>工作目录：{execution.cwd}</p><pre>{execution.output}</pre>
            </details>)}
          </details>}
        </>
      )}
      <div className="bundle-actions">
        <button
          className={current ? "button secondary" : "button primary"}
          disabled={disabled || Boolean(task.analysis&&(!task.planApproved||task.analysis.missing.length))}
          onClick={() => void act(async()=>{
            const next=await requestMigrationWork(api,task.id,crypto.randomUUID(),'implement');if(next)setTask(next);
            setMessage('已交给主 Agent 实施迁移，进展显示在任务对话中。');
          })}
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
