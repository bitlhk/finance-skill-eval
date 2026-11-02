import type {BundleTask} from '../../../../src/migration/tasks/domain/task-model';
export function RuntimeRequirements({task}:{task:BundleTask}) {
  const plan=task.analysis?.plan;
  const review=task.runtimeReviewCurrent?task.runtimeReview:undefined;
  const requirements=review?.items??[
    ...(plan?.requiredCapabilities??[]).map(item=>({name:item.name,status:'UNVERIFIED' as const,reason:item.reason})),
    ...(plan?.dependencies??[]).map(item=>({name:item.name,status:'UNVERIFIED' as const,reason:item.contract+'；'+item.configuration})),
    ...(plan?.conditions??[]).map(name=>({name,status:'UNVERIFIED' as const,reason:'需要核验的运行条件'})),
  ];
  return <section className="stage-section"><h4>本次迁移需要的运行条件</h4>
    {!plan&&<p>原记录未单独保存完整运行要求，请先核对迁移方案；不能默认已登记环境满足要求。</p>}
    {!!task.runtimeReview&&!task.runtimeReviewCurrent&&<p role="status">方案、结果或环境选择已变化，需要重新核对。</p>}
    {!!requirements.length&&<details className="stage-detail"><summary>查看运行条件与核对结果（{requirements.length} 项）</summary><div className="runtime-requirements">{requirements.map((item,index)=><article key={index}><header><strong>{item.name}</strong><span className={`stage-badge ${item.status==='SATISFIED'?'success':item.status==='UNSATISFIED'?'danger':'pending'}`}>{item.status==='SATISFIED'?'声明已核对':item.status==='UNSATISFIED'?'不满足':'待验证'}</span></header><p>{item.reason}</p></article>)}</div></details>}
    {plan&&!requirements.length&&<p>方案未提出额外运行要求，仍需核对环境连接并进行启动和业务验证。</p>}
    {review&&<p role="status">{review.status==='PASSED'?'已登记能力与方案要求一致，可继续实际验证。':review.status==='FAILED'?'尚有运行条件未满足，请补齐配置或选择符合要求的环境。':'已完成可核对部分；其余条件缺少证据，仍需实际验证。'}</p>}
  </section>;
}
