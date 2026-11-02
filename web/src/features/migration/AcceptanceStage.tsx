import { SuiteEditor } from './SuiteEditor';
import {useState} from 'react';
import {OptimizationSettings,OptimizationHistory,defaultOptimizationGoal} from '../../OptimizationHistory';
import { editableSuite } from './SuiteEditor';
import type { MigrationWorkbench } from './useMigrationWorkbench';
import type { BundleTask } from '../../../../src/migration/tasks/domain/task-model';
import {hasCandidateFailures} from '../../../../src/migration/tasks/domain/task-verdict';
import { statusLabels,sameConfiguration } from './presentation';
import { MigrationRunView } from './MigrationRunView';
import {downloadApi} from '../../api-path';
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
          <button className="button secondary" disabled={frozen || !editableSuite(suite) || (editableSuite(suite)?.cases.length ?? 0)>=8} onClick={()=>{
            const currentSuite=editableSuite(suite);if(!currentSuite)return;
            setSuite(JSON.stringify({...currentSuite,cases:[...currentSuite.cases,{id:crypto.randomUUID(),input:check.procedure,criteria:[check.expectedResult],...(task.analysis?.standardization?{requirementIds:[check.id]}:{})}]},null,2));
          }}>添加到测试案例</button></section>)}
        <p>请补齐真实输入与测试文件。方案中的预期结果只作为评审标准，不会当作执行结果。</p>
      </details>}
      <SuiteEditor value={suite} onChange={setSuite} disabled={frozen}/>
      {task.analysis?.standardization&&<details className="stage-detail"><summary>关联原业务能力与运行条件</summary><p>每项要求需要对应真实测试；仅添加关联不会视为已验证。</p>
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
          run={run}
          currentCandidateId={task.currentCandidateId}
          experimental={task.attempts.some(a=>a.optimization?.rounds.some(round=>round.candidate?.id===run.candidateId))}
          configurationMatches={
            JSON.stringify(run.configuration) === JSON.stringify(task.configuration) &&
            JSON.stringify(run.suite) === JSON.stringify(task.suite) &&
            run.judgeDigest === task.currentJudgeDigest &&
            run.runtimeSelectionRevision === task.runtimeSelectionRevision &&
            run.builderBindingId === (task.selectedRuntimeBuildRequestId ? task.runtimeDelivery?.id : undefined)
          }
        />
      )}
      {run?.status==='INCOMPLETE' && <p role="status">{run.cases.some(c=>c.failureStage==='JUDGE'||c.failureStage==='RUNTIME')?'部分执行或评审未完成，请查看案例原因后重试；已取得的证据会保留。':'尚有原能力或运行条件未验证，请补充对应案例与输入；已经通过的检查不代表全部要求均已验证。'}</p>}
      {run?.requirementCoverage&&<section className="stage-secondary-card"><h4>原能力与运行要求覆盖</h4><ul>{run.requirementCoverage.map(r=><li key={r.id}>{r.status==='PASSED'?'已验证':r.status==='FAILED'?'未通过':'尚未验证'}：{task.analysis?.standardization?.requirements.find(item=>item.id===r.id)?.statement??r.id}</li>)}</ul></section>}
      {optimizationAttempt?.status!=='WAITING'&&run?.phase==='development'&&run.candidateId===task.currentCandidateId&&['PASSED','FAILED'].includes(run.status)&&<>
        <OptimizationSettings value={optimizationGoal} onChange={setOptimizationGoal} disabled={disabled} cases={run.cases}/>
        <button className="button primary" disabled={disabled||builderBlocked} onClick={()=>void act(async()=>{await start('optimize',{runId:run.id,optimization:optimizationGoal});})}>按目标优化并复测</button>
      </>}
      {optimizationAttempt?.optimization&&<>
        <OptimizationHistory loop={optimizationAttempt.optimization} onRun={setRunId}/>
        {optimizationAttempt.status==='WAITING'&&<section className="stage-secondary-card" aria-label="继续优化">
          <p>{optimizationAttempt.optimization.waiting?.kind==='BUILDER'?'工程候选与诊断已保存。请在“准备运行环境”生成 Builder 需求，下载工程代码交给 Builder 改造并导入交付。':optimizationAttempt.optimization.waiting?.kind==='CONFIGURATION'?'请在“准备运行环境”补充并保存配置，然后继续本轮优化。':'请先停止本任务，再确认并调整评测方案。'}</p>
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
        hasCandidateFailures(run) &&
        !run.cases.some(c=>c.failureStage==='JUDGE' || c.failureStage==='RUNTIME') &&
        run.phase === 'development' && (
          <button
            className="button primary"
            disabled={frozen}
            onClick={() =>
              void act(async () => {
                await start('repair', { runId: run.id });
                setStage(2);
              })
            }
          >
            根据结果修复
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
