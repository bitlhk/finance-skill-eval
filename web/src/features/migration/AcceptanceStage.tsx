import { SuiteEditor } from './SuiteEditor';
import {useState} from 'react';
import {OptimizationSettings,OptimizationHistory,defaultOptimizationGoal} from '../../OptimizationHistory';
import { editableSuite } from './SuiteEditor';
import type { MigrationWorkbench } from './useMigrationWorkbench';
import type { BundleTask } from "../../../../contracts/platform/responses";
import { statusLabels,sameConfiguration,sameEvaluationSuite } from './presentation';
import { MigrationRunView } from './MigrationRunView';
import {downloadApi} from '../../api-path';
import {startEvidenceRepair} from './start-evidence-repair';
import {requestCaseDesign} from './case-proposals';
import {MIGRATION_CASE_LIMIT} from './form-limits';
export function AcceptanceStage({ state }: { state: MigrationWorkbench; }) {
  const [optimizationGoal,setOptimizationGoal]=useState(defaultOptimizationGoal);
  const { api, task, setTask, setStage, setMessage, suite, setSuite, setRunId, current, run, act, start, disabled } = state;
  if (!task) return null;
  async function saveSuite() {
    let parsed;
    try { parsed = JSON.parse(suite); } catch { throw new Error('测试集格式不正确，请在高级设置中检查。'); }
    if (typeof parsed?.name !== 'string' || !parsed.name.trim() || !Array.isArray(parsed.cases) || !parsed.cases.length ||
      parsed.cases.some((item: { input?: string; criteria?: string[] }) => !item || typeof item.input !== 'string' || !item.input.trim() || !Array.isArray(item.criteria) || !item.criteria.length || item.criteria.some(c => typeof c !== 'string' || !c.trim()))) {
      throw new Error('请填写测试名称、任务内容和预期结果。');
    }
    setTask(await api<BundleTask>('/api/migration-tasks/' + task!.id + '/suite', { method: 'PUT', body: JSON.stringify(parsed) }));
  }
  const builderBlocked = ['PENDING', 'STALE'].includes(task.builderStatus ?? '');
  const selectedBuilder=task.runtimeBuildRequests?.find(item=>item.requirements.requestId===task.selectedRuntimeBuildRequestId);
  const selectedNewBuilder=Boolean(run&&task.builderStatus==='PENDING'&&selectedBuilder
    &&selectedBuilder.candidateId===run.candidateId&&selectedBuilder.candidateDigest===run.candidateDigest&&!selectedBuilder.requirements.rebuild
    &&Date.parse(selectedBuilder.createdAt)>=Date.parse(run.createdAt)&&sameConfiguration(run.configuration,task.configuration)&&sameEvaluationSuite(run.suite,task.suite));
  const optimizationAttempt=[...task.attempts].reverse().find(a=>a.kind==='OPTIMIZE');
  const waiting=optimizationAttempt?.status==='WAITING'?optimizationAttempt.optimization?.waiting:undefined;
  const frozen=disabled||!!waiting;
  const previous=task.runs.find(r=>r.id===optimizationAttempt?.optimization?.workingEvaluationId);
  const resumeReady=waiting?.kind==='BUILDER'?!!waiting.requestId&&task.builderStatus==='BOUND'
    &&task.selectedRuntimeBuildRequestId===waiting.requestId&&task.runtimeDelivery?.requestId===waiting.requestId
    :waiting?.kind==='CONFIGURATION'&&!!task.configuration&&!!previous&&!sameConfiguration(task.configuration,previous.configuration);
  return (
    <section className="migration-stage">
      <div className="migration-stage-heading"><div><h3>验证实际效果</h3><p>让迁移后的 Skill 执行真实任务，检查结果是否符合预期。支持多个 Skill 共同完成任务。</p></div></div>
      {!!task.analysis?.plan?.acceptanceChecks.length && <details className="stage-detail restored-plan"><summary>方案中的验收要求</summary>
        {task.analysis.plan.acceptanceChecks.map(check=><section key={check.id}><h4>{check.purpose}</h4><p>{check.procedure}</p><p>预期结果：{check.expectedResult}</p>
          <button className="button secondary" disabled={frozen || !editableSuite(suite) || (editableSuite(suite)?.cases.length ?? 0)>=MIGRATION_CASE_LIMIT} onClick={()=>{
            const currentSuite=editableSuite(suite);if(!currentSuite)return;
            setSuite(JSON.stringify({...currentSuite,cases:[...currentSuite.cases,{id:crypto.randomUUID(),input:check.procedure,criteria:[check.expectedResult],...(task.analysis?.standardization?{requirementIds:[check.id]}:{})}]},null,2));
          }}>添加到测试案例</button></section>)}
        <p>请补齐真实输入与测试文件。方案中的预期结果只作为评审标准，不会当作执行结果。</p>
      </details>}
      <SuiteEditor value={suite} onChange={setSuite} disabled={frozen} onSuggest={()=>void act(async()=>{
        const next=await requestCaseDesign(api,task.id,crypto.randomUUID(),suite);if(next)setTask(next);
        setMessage('已请主 Agent 设计案例，完成后可在任务对话中审阅。');
      })}/>
      {task.analysis?.standardization&&<details className="stage-detail"><summary>关联原业务能力与运行条件</summary><p>可以将相关要求关联到效果案例；基础能力也可通过工程测试或工具入口检查，添加关联本身不代表已验证。</p>
        {editableSuite(suite)?.cases.map((c,index)=><section key={c.id}><h4>测试案例 {index+1}</h4>{task.analysis!.standardization!.requirements.map(r=><label key={r.id} style={{display:'flex',alignItems:'baseline',gap:8,fontSize:'inherit'}}><input style={{width:'auto'}} type="checkbox" disabled={disabled} checked={c.requirementIds?.includes(r.id)??false} onChange={e=>{const value=editableSuite(suite);if(!value)return;setSuite(JSON.stringify({...value,cases:value.cases.map(item=>item.id!==c.id?item:{...item,requirementIds:e.target.checked?[...(item.requirementIds??[]),r.id]:(item.requirementIds??[]).filter(id=>id!==r.id)})},null,2));}}/>{r.statement}</label>)}</section>)}
      </details>}
      <div className="bundle-actions">
        <button
          className="button secondary"
          disabled={frozen}
          onClick={() =>
            void act(async () => {
              await saveSuite();
              setMessage('验收测试集已保存');
            })
          }
        >
          保存测试集
        </button>
        <button
          className="button primary"
          disabled={frozen || builderBlocked || !current || !task.configuration || task.candidatePlanCurrent===false || task.runtimeReviewCurrent && task.runtimeReview?.status==='FAILED'}
          onClick={() =>
            void act(async () => {
              await saveSuite();
              setRunId('');
              await start('acceptance', { phase: 'development' });
            })
          }
        >
          开始验证实际效果
        </button>
        {Boolean(task.suite?.holdoutCases?.length) && (
          <button
            className="button secondary"
            disabled={frozen || builderBlocked || !current || !task.configuration || task.candidatePlanCurrent===false || task.runtimeReviewCurrent && task.runtimeReview?.status==='FAILED'}
            onClick={() =>
              void act(async () => {
                await saveSuite();
                setRunId('');
                await start('acceptance', { phase: 'holdout' });
              })
            }
          >
            执行独立留出验收
          </button>
        )}
      </div>
      {task.projectComparison&&<section className="stage-secondary-card" aria-label="原工程与迁移结果对照">
        <h4>原工程与迁移结果对照</h4>
        <p>同一开发集由各自的评判结果对照；这不是额外的模型相对评分。运行环境可以不同，未完成或条件已变化的记录不会用于此对照。</p>
        {task.projectComparison.cases.map(item=><p key={item.id}>{item.id}：原工程 {item.baseline?.passed}/{item.baseline?.total}，迁移结果 {item.candidate?.passed}/{item.candidate?.total}</p>)}
      </section>}
      {task.runs.length > 0 && (
        <label>
          运行记录
          <select aria-label="运行记录" value={run?.id ?? ''} onChange={(e) => setRunId(e.target.value)}>
            {[...task.runs].reverse().map((r) => (
              <option key={r.id} value={r.id}>
                {r.createdAt} · {r.phase === 'holdout' ? '留出' : '开发'} · {statusLabels[r.status]}
              </option>
            ))}
          </select>
        </label>
      )}
      {run && (
        <MigrationRunView
          disabled={disabled||task.rescoringOperation?.status==='RUNNING'} rescorings={task.rescorings} rescoringOperation={task.rescoringOperation}
          taskId={task.id} allRuns={task.runs} analyses={task.runAnalyses} onAnalyze={()=>void act(async()=>{setTask(await api<BundleTask>(`/api/migration-tasks/${task.id}/analyze-run`,{method:'POST',body:JSON.stringify({runId:run.id})}));})}
          onRescore={repetitions=>void act(async()=>{setTask(await api<BundleTask>(`/api/migration-tasks/${task.id}/rescore/start`,{method:'POST',body:JSON.stringify({runId:run.id,repetitions})}));})}
          onCancelRescore={()=>void act(async()=>{setTask(await api<BundleTask>(`/api/migration-tasks/${task.id}/cancel`,{method:'POST'}));})}
          run={run}
          currentCandidateId={task.currentCandidateId}
          experimental={task.attempts.some(a=>a.optimization?.rounds.some(round=>round.candidate?.id===run.candidateId))}
          configurationMatches={run.configurationCurrent===true}
        />
      )}
      {run?.status==='INCOMPLETE' && <p role="status">{run.cases.some(c=>c.failureStage==='JUDGE'||c.failureStage==='RUNTIME')?'部分执行或评审未完成，请查看案例原因后重试；已取得的证据会保留。':'本次验证尚不完整，请查看已有证据和未覆盖范围，选择合适的工程检查或效果案例继续验证。'}</p>}
      {optimizationAttempt?.status!=='WAITING'&&run?.phase==='development'&&run.candidateId===task.currentCandidateId&&['PASSED','FAILED'].includes(run.effectStatus??run.status)&&<>
        <OptimizationSettings value={optimizationGoal} onChange={setOptimizationGoal} disabled={disabled} cases={run.cases}/>
        {selectedNewBuilder&&<p>新建 Runtime 尚未交付；主 Agent 会准备所选运行环境，交付后继续当前任务。</p>}
        <button className="button primary" disabled={disabled||builderBlocked&&!selectedNewBuilder} onClick={()=>void act(async()=>{
          const details=JSON.stringify(optimizationGoal);
          const result=await api<{task?:BundleTask}>(`/api/migration-tasks/${task.id}/conversation/message`,{method:'POST',body:JSON.stringify({
            key:crypto.randomUUID(),text:`请基于开发集运行 ${run.id} 按以下目标开展优化，诊断后自行调整、复测并请求独立审查，遵守轮次和时间预算：${details}`,
            optimization:{runId:run.id,goal:optimizationGoal}})});
          if(result.task)setTask(result.task);
          setMessage('已交给主 Agent 按所选目标开展优化，进展显示在任务对话中。');
        })}>按目标优化并复测</button>
      </>}
      {optimizationAttempt?.optimization&&<>
        <OptimizationHistory loop={optimizationAttempt.optimization} onRun={setRunId}/>
        {optimizationAttempt.status==='WAITING'&&<section className="stage-secondary-card" aria-label="继续优化">
          <p>{optimizationAttempt.optimization.waiting?.kind==='BUILDER'?'工程候选与诊断已保存。请在“准备运行环境”查看构建需求；当前接口不支持重建时，需要外部完成改造并导入交付。':optimizationAttempt.optimization.waiting?.kind==='CONFIGURATION'?'请在“准备运行环境”补充并保存配置，然后继续本轮优化。':'请先停止本任务，再确认并调整评测方案。'}</p>
          <button className="button secondary" disabled={disabled} onClick={()=>setStage(3)}>前往准备运行环境</button>
          <button className="button secondary" disabled={disabled} onClick={()=>void act(()=>downloadApi(`/api/migration-tasks/${task.id}/optimization-workspace?attemptId=${optimizationAttempt.id}`,'optimization-project.zip'))}>下载优化工程与诊断</button>
          {optimizationAttempt.optimization.waiting?.kind!=='INPUT'&&<button className="button primary" disabled={disabled||!resumeReady} onClick={()=>void act(()=>start('optimize',{resumeAttemptId:optimizationAttempt.id}))}>继续本轮优化</button>}
          <button className="button secondary" disabled={disabled} onClick={()=>void act(async()=>{setTask(await api<BundleTask>(`/api/migration-tasks/${task.id}/cancel`,{method:'POST'}));})}>停止此优化任务</button>
        </section>}
        {optimizationAttempt.optimization.status==='REVIEW'&&task.currentCandidateId===optimizationAttempt.optimization.baseline.id&&
          <button className="button primary" disabled={disabled} onClick={()=>void act(async()=>{
            setTask(await api<BundleTask>(`/api/migration-tasks/${task.id}/optimization-selection`,{method:'POST',body:JSON.stringify({attemptId:optimizationAttempt.id})}));
            setRunId(optimizationAttempt.optimization!.bestEvaluationId);setMessage('已选择审查通过的候选；如有留出集，请继续独立验收。');
          })}>选择审查通过的候选</button>}
      </>}
      {run &&
        run.candidateId === task.currentCandidateId &&
        ['FAILED', 'INCOMPLETE'].includes(run.status) &&
        run.hasCandidateFailures &&
        !run.cases.some(c=>c.failureStage==='JUDGE' || c.failureStage==='RUNTIME') &&
        run.phase === 'development' && (
          <button
            className="button primary"
            disabled={frozen}
            onClick={() =>
              void act(async () => {
                const updated=await startEvidenceRepair(api,task.id,run.id,crypto.randomUUID());
                if(updated)setTask(updated);
                setMessage('已交给主 Agent 诊断和修复，进展显示在任务对话中。');
              })
            }
          >
            诊断、修复并复测
          </button>
        )}
      <div className="bundle-actions">
        <button className="button secondary" disabled={!current} onClick={() => setStage(6)}>
          下一步：下载结果
        </button>
      </div>
    </section>
  );
}
