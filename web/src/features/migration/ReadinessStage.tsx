import type { MigrationWorkbench } from './useMigrationWorkbench';
import type { BundleTask } from "../../../../contracts/platform/responses";
export function ReadinessStage({ state }: { state: MigrationWorkbench; }) {
  const { api, task, setTask, setStage, setMessage, current, act, disabled, setCheckingRuntime } = state;
  if (!task) return null;
  const coverageRun=[...task.runs].reverse().find(run=>run.purpose!=='baseline'&&run.candidateId===task.currentCandidateId&&run.requirementCoverage?.length);
  const coverageCurrent=coverageRun?.requirementCoverageCurrent===true;
  const review=[...(task.deliveryReviews??[])].reverse().find(item=>item.candidateId===current?.id&&item.workspaceDigest===current?.digest);
  const checks=[...(task.preparations??[]).flatMap(item=>item.executions),...task.attempts.flatMap(item=>item.executions??[])];
  return (
    <section className="migration-stage">
      <div className="migration-stage-heading"><div><h3>基础验证</h3><p>
        检查原有能力、运行要求和工具是否可用。启动检查只是其中一项，不能代表业务能力已验证。
      </p></div></div>
      <div className="bundle-actions">
        <button className="button primary" disabled={disabled||!current} onClick={()=>void act(async()=>{
          const response=await api<{task?:BundleTask}>(`/api/migration-tasks/${task.id}/conversation/message`,{method:'POST',body:JSON.stringify({
            key:crypto.randomUUID(),text:'请按本任务已确定的业务范围完成基础验证：检查原能力保留、工程可运行及实际交付工具入口；按需运行工程测试、契约检查和真实调用，诊断并修复发现的问题后复测，再委派独立交付审查。无需为代码测试生成问答案例，也不要自行启动效果优化；缺少必要运行条件时向我说明并询问。'})});
          if(response.task)setTask(response.task);
        })}>验证并修复当前工程</button>
        <button
          className="button secondary"
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
      {review?.basicReview&&<section className="stage-secondary-card"><h4>独立基础验证审查</h4>
        <p>{review.basicReview.scope}</p><p>{review.basicReview.reason}</p>
        <p>{task.basicDelivery?'已有当前版本可交付的基础验证结论':'尚未形成当前版本有效的基础验证交付结论，请在任务对话中继续处理缺口。'}</p>
      </section>}
      {!!checks.length&&<details className="stage-detail"><summary>工程检查与复测记录（{checks.length}）</summary>
        {checks.map((check,index)=><article key={check.receiptId??index}><p>{check.command.join(' ')} · {check.status} · 退出码 {check.exitCode??'未取得'}</p>
          <p>{check.snapshotDigest===current?.digest?'对应当前文件':'对应历史文件，修改后需重新验证'}</p></article>)}
      </details>}
      {task.startupCheck && <p role="status">{task.startupCheckCurrent ? task.startupCheck.message : '迁移结果或环境配置已变化，需要重新执行启动检查。'}</p>}
      {!!current?.contractEvidence?.length&&<section className="stage-secondary-card"><h4>工具调用检查</h4><p>以下是生成候选时保存的检查记录，不能替代当前环境中的实际验证。</p><ul>{current.contractEvidence.map(item=><li key={item.toolId}>{item.toolId}：{item.passed&&item.callExecuted?'已实际调用':'尚未验证通过'} · {item.detail}</li>)}</ul></section>}
      {coverageRun?.requirementCoverage&&<section className="stage-secondary-card"><h4>原能力与运行要求覆盖</h4>
        <p>{coverageCurrent?'来自已保存的业务运行记录。':'运行环境或配置已变化，以下为历史证据，不能代表当前环境。'}</p><ul>{coverageRun.requirementCoverage.map(r=><li key={r.id}>{r.status==='PASSED'?'已验证':r.status==='FAILED'?'未通过':'尚未验证'}：{task.analysis?.standardization?.requirements.find(item=>item.id===r.id)?.statement??r.id}
          {r.status==='UNVERIFIED'&&r.plannedCaseIds?.length===0&&<span>（尚未关联测试案例）</span>}
          {!!r.pendingCaseIds?.length&&<span>（这些案例尚无完整判定：{r.pendingCaseIds.join('、')}）</span>}</li>)}</ul></section>}
      {!coverageRun&&<p>原能力和运行要求尚无关联的业务验证记录。可在效果评测中复用已有案例提供证据。</p>}
    </section>
  );
}
