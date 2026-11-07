import {useEffect,useState} from 'react';
import type {OptimizationLoop,OptimizationGoal} from "../../contracts/platform/responses";

export const defaultOptimizationGoal:OptimizationGoal={goal:'提高整体任务效果，结合业务目标权衡改善与回退',maxRounds:1,targetPassRate:1};
export function OptimizationSettings({value,onChange,disabled,cases=[]}:{value:OptimizationGoal;onChange(value:OptimizationGoal):void;disabled?:boolean;cases?:Array<{id:string}>}){
  const [rounds,setRounds]=useState(String(value.maxRounds));
  useEffect(()=>setRounds(String(value.maxRounds)),[value.maxRounds]);
  return <div className="stage-secondary-card">
    <label>优化目标<input aria-label="优化目标" value={value.goal} disabled={disabled} maxLength={2000} onChange={e=>onChange({...value,goal:e.target.value})}/></label>
    <label>最多调整轮次<input aria-label="最多调整轮次" type="number" min={1} step={1} value={rounds} disabled={disabled} onBlur={()=>setRounds(String(value.maxRounds))} onChange={e=>{const text=e.target.value;setRounds(text);const n=Number(text);if(text&&Number.isSafeInteger(n)&&n>=1)onChange({...value,maxRounds:n});}}/></label>
    <label>开发集目标通过率<select aria-label="开发集目标通过率" value={value.targetPassRate} disabled={disabled} onChange={e=>onChange({...value,targetPassRate:Number(e.target.value)})}>{[1,.9,.8].map(n=><option key={n} value={n}>{n*100}%</option>)}</select></label>
    <label>时间预算（可选）<select aria-label="时间预算" value={value.maxDurationSeconds??''} disabled={disabled} onChange={e=>onChange({...value,maxDurationSeconds:e.target.value?Number(e.target.value):undefined})}>
      <option value="">不限制总时长</option>{value.maxDurationSeconds!==undefined&&![900,1800,3600,7200].includes(value.maxDurationSeconds)&&<option value={value.maxDurationSeconds}>{value.maxDurationSeconds} 秒</option>}{[900,1800,3600,7200].map(n=><option key={n} value={n}>{n/60} 分钟</option>)}</select></label>
    {cases.length>0&&<details><summary>必须通过的案例（可选）</summary><p>只选择本次优化不可牺牲的要求。其他案例的改善和回退由独立审查结合目标判断。</p>
      {cases.map(c=><label key={c.id}><input type="checkbox" disabled={disabled} checked={value.protectedCaseIds?.includes(c.id)??false}
        onChange={e=>onChange({...value,protectedCaseIds:e.target.checked?[...(value.protectedCaseIds??[]),c.id]:(value.protectedCaseIds??[]).filter(id=>id!==c.id)})}/>{c.id}</label>)}
    </details>}
    <p>每轮包含诊断、调整、复测和独立审查。审查可推荐候选，也可在有潜力的候选上继续修复。留出验收结果不用于继续修改。</p>
  </div>;
}
export function OptimizationHistory({loop,onRun}:{loop:OptimizationLoop;onRun?:(id:string)=>void}){
  const labels={DIAGNOSIS:'诊断',ADJUSTMENT:'调整',EVALUATION:'复测',REVIEW:'独立审查',SELECTION:'选择候选'};
  return <section className="stage-secondary-card" aria-label="优化过程">
    <h4>优化过程 · {loop.rounds.length} / {loop.goal.maxRounds} 轮</h4><p>{loop.goal.goal} · 目标通过率 {loop.goal.targetPassRate*100}%</p>
    <p role="status">{loop.reason??`正在${labels[loop.stage]}`}</p>
    {loop.status==='WAITING'&&<p>本轮已保存。等待期间不占用优化时间预算，外部调整完成后从本轮复测继续。</p>}
    {!!loop.contextChanges?.length&&<p>本次包含已确认的 Runtime 或配置变更，Review 评估的是整套方案的效果。</p>}
    {loop.rounds.map(round=><details key={round.number} open={round.number===loop.rounds.length}>
      <summary>第 {round.number} 轮 · {round.selected?'推荐此候选':round.continued?'保留为实验版本，继续修复':round.selected===false?'保留此前推荐版本':labels[round.stage]}</summary>
      {round.diagnosis&&<p>诊断：{round.diagnosis.status==='ABSTAINED'?round.diagnosis.reason:round.diagnosis.hypothesis.issue}</p>}
      {round.diagnosis?.status==='PROPOSED'&&<p>验证方法：{round.diagnosis.hypothesis.validation}</p>}
      {round.review&&<p>独立审查：{round.review.status==='ABSTAINED'?round.review.reason:round.review.review.reason}</p>}
      {round.review?.status==='PRODUCED'&&<><p>改善：{round.review.review.improvements.join('；')||'未确认'}</p><p>回退：{round.review.review.regressions.join('；')||'未发现'}</p></>}
      {round.review?.status==='PRODUCED'&&round.review.review.tradeoff&&<p>取舍依据：{round.review.review.tradeoff}</p>}
      {round.review?.status==='PRODUCED'&&!!round.review.review.nextFocus?.length&&<p>后续修复：{round.review.review.nextFocus.join('；')}</p>}
      {round.reason&&<p>选择原因：{round.reason}</p>}
      {!!round.investigation?.length&&<details><summary>诊断查阅的证据与调用记录</summary><pre>{JSON.stringify(round.investigation,null,2)}</pre></details>}
      {round.evaluationId&&onRun&&<button className="button secondary" onClick={()=>onRun(round.evaluationId!)}>查看本轮复测</button>}
    </details>)}
  </section>;
}
