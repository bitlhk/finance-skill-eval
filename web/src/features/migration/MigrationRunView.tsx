import type { BundleRun } from "../../../../contracts/platform/responses";
import { caseResultLabel,statusLabels } from './presentation';
import {EvaluationEvidence} from '../../EvaluationEvidence';
import type {TaskRescoring} from "../../../../contracts/platform/responses";
import {useState} from 'react';
import {AssessmentStability} from '../../AssessmentStability';
import {HumanReviewPanel} from '../../HumanReviewPanel';
export function MigrationRunView({
  run,
  currentCandidateId,
  configurationMatches,
  experimental=false,
  onRescore,onCancelRescore,rescorings,rescoringOperation,disabled,onAnalyze,analyses,allRuns,taskId,
}: {
  run: BundleRun;
  currentCandidateId: string | null;
  configurationMatches: boolean;
  experimental?:boolean;
  onRescore?:(repetitions:number)=>void;rescorings?:TaskRescoring[];disabled?:boolean;
  onCancelRescore?:()=>void;
  rescoringOperation?:import("../../../../contracts/platform/responses").BundleTask['rescoringOperation'];
  onAnalyze?:()=>void;analyses?:import("../../../../contracts/platform/responses").SavedRunAnalysis[];
  allRuns?:BundleRun[];
  taskId?:string;
}) {
  const [repetitions,setRepetitions]=useState(1);
  return (
    <div className="bundle-run">
      <h4>{run.purpose === 'baseline' ? '原工程基线 · ' : ''}
        {statusLabels[run.status]} · {run.cases.filter((c) => c.passed).length}/
        {run.phase === 'holdout' ? run.suite.holdoutCases?.length : run.suite.cases.length} 个案例通过
      </h4>
      {run.effectStatus&&<p>效果评测：{statusLabels[run.effectStatus]}。基础要求的验证情况单独列示，整体验收仍需满足基础要求。</p>}
      {taskId&&run.status!=='RUNNING'&&<HumanReviewPanel source={{kind:'migration',id:taskId,runId:run.id}}/>}
      {run.repetition&&<section><h5>业务重复运行 · 第 {run.repetition.index}/{run.repetition.total} 次</h5>
        <p>以下统计包含本组全部计划次数；未执行或证据不完整的次数不算通过。</p>
        {(run.executionStatistics??[])
          .map(item=><p key={item.caseId}>{item.caseId}：通过 {item.passed}/{item.total}，失败 {item.failed}，未完成或无法验证 {item.unverified}；{item.allPassed?'每次均通过':item.variableOutcomes?'存在结果波动':'未达到每次均通过'}。</p>)}
      </section>}
      {onRescore&&<><label>重复评判次数<select aria-label="重复评判次数" disabled={disabled} value={repetitions} onChange={event=>setRepetitions(Number(event.target.value))}>{[1,2,3,4,5].map(n=><option value={n} key={n}>{n}</option>)}</select></label>
        <button className="button secondary" disabled={disabled||run.status==='RUNNING'} onClick={()=>onRescore(repetitions)}>使用已保存证据重新评判</button></>}
      {rescoringOperation?.sourceRunId===run.id&&rescoringOperation.status==='RUNNING'&&<div><p role="status">正在使用已保存证据重新评判，完成后自动显示结果。</p>{onCancelRescore&&<button className="button secondary" onClick={onCancelRescore}>停止重新评判</button>}</div>}
      {rescoringOperation?.sourceRunId===run.id&&['FAILED','CANCELLED','INTERRUPTED'].includes(rescoringOperation.status)&&<p role="alert">{rescoringOperation.error}</p>}
      {onAnalyze&&run.phase==='development'&&<button className="button secondary" disabled={disabled||run.status==='RUNNING'} onClick={onAnalyze}>分析本次评测问题</button>}
      {analyses?.filter(record=>record.sourceRunId===run.id).map(record=><details key={record.id}><summary>问题分析 · {record.createdAt}</summary>
        <p>基于本次冻结证据和工程版本分析，不修改代码或启动业务运行。原因判断是待验证假设。</p>
        {record.judgement.status==='ABSTAINED'?<p>{record.judgement.reason}</p>:<>
          <p>{record.judgement.hypothesis.issue}</p><p>验证建议：{record.judgement.hypothesis.validation}</p>
          <p>证据案例：{record.judgement.hypothesis.evidenceCaseIds.join('、')}</p>
        </>}
        <details><summary>完整分析及证据查询</summary><pre>{JSON.stringify(record,null,2)}</pre></details>
      </details>)}
      {rescorings?.filter(record=>record.sourceRunId===run.id).map(record=><details key={record.id}><summary>重新评判 · {record.createdAt}</summary>
        <p>复用历史执行证据，不替换原验收结论，也不执行任何业务操作。</p>
        <AssessmentStability items={record.stability}/>
        {record.attempts&&<details><summary>每次评分记录（下方展示首次）</summary><pre>{JSON.stringify(record.attempts,null,2)}</pre></details>}
        {record.cases.map(item=><article key={item.id}><p>{item.id} · {item.reason}</p><EvaluationEvidence methods={item.methodResults}/></article>)}
      </details>)}
      {run.candidateId !== currentCandidateId && (
        <p className="bundle-notice">{run.purpose==='baseline'?'历史工程版本的基线记录。':experimental?'这是优化实验候选的复测记录，尚未替换当前版本。':'历史候选的验收记录；当前候选需重新验收。'}</p>
      )}
      {!configurationMatches && (
        <p className="bundle-notice">Runtime 选择、运行配置、测试集或 Judge 已变化；此记录不能作为当前交付的验收结论。</p>
      )}
      {run.cases.map((c) => (
        <details key={c.id}>
          <summary>
            {c.id} · {caseResultLabel(c)}
          </summary>
          <p>{c.reason}</p>
          {(['answer','execution'] as const).map(scope=>{
            const criteria=c.criteria?.filter(item=>item.scope===scope)??[];
            return criteria.length?<section key={scope}><h5>{scope==='answer'?'回答质量':'执行与业务正确性'}</h5>
              {criteria.map(item=><p key={item.id}>{item.passed===null?'无法验证':item.passed?'通过':'失败'} · {item.reason}</p>)}</section>:null;
          })}
          <EvaluationEvidence methods={c.methodResults} evidence={c.evidence}/>
          {!!c.investigation?.length&&<details><summary>评判过程与用量</summary><pre>{JSON.stringify(c.investigation,null,2)}</pre></details>}
          <h5>实际输出</h5>
          <pre>{c.evidence?.output ?? '未获得执行结果'}</pre>
          <h5>装载成员</h5>
          <p>{c.evidence?.loadedSkills.map((s) => s.skillId + ' · ' + s.version).join('、') ?? '未采集'}</p>
          <p>Skill 激活证据以工具记录为准，装载不表示每个成员均被调用。</p>
          <details>
            <summary>工具与运行证据</summary>
            <pre>{JSON.stringify(c.evidence, null, 2)}</pre>
          </details>
        </details>
      ))}
    </div>
  );
}
