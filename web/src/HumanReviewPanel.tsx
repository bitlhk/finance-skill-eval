import {useState} from 'react';
import {api} from './api-client';
import {reviewConsensus,type ReviewSource} from '../../src/evaluation/domain/human-review';
import type {HumanReviewView} from '../../src/service/human-review-store';

const labels:Record<string,string>={PASS:'通过',FAIL:'失败',UNVERIFIED:'无法验证',left:'左侧更好',right:'右侧更好',tie:'相当',
  case:'案例结论',criterion:'评分标准',pairwise:'两侧偏好',method:'检查方法'};
export function HumanReviewPanel({source}:{source:ReviewSource}){
  return <ReviewForm key={JSON.stringify(source)} source={source}/>;
}
function ReviewForm({source}:{source:ReviewSource}){
  const [view,setView]=useState<HumanReviewView|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [selected,setSelected]=useState(''),[reviewer,setReviewer]=useState(''),[outcome,setOutcome]=useState('UNVERIFIED');
  const [reason,setReason]=useState(''),[refs,setRefs]=useState(''),[importText,setImportText]=useState('');
  const target=view?.targets.find(t=>t.id===selected)??view?.targets[0];
  const consensus=target&&view?reviewConsensus(target,view.records):null;
  const work=async(action:()=>Promise<HumanReviewView>)=>{
    setBusy(true);setError('');try{setView(await action());}catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  };
  const load=()=>work(()=>api<HumanReviewView>('/api/evaluation-reviews?'+new URLSearchParams(source).toString()));
  const submit=(kind:'ANNOTATION'|'ADJUDICATION')=>{
    if(!view||!target)return;
    const previous=consensus?.annotations.find(r=>r.reviewer===reviewer.trim());
    return work(()=>api<HumanReviewView>('/api/evaluation-reviews',{method:'POST',body:JSON.stringify({source,sourceDigest:view.sourceDigest,entries:[{
      targetId:target.id,reviewer,kind,outcome,reason,evidenceRefs:refs.split('\n').map(s=>s.trim()).filter(Boolean),
      ...(kind==='ANNOTATION'&&previous?{supersedes:previous.id}:{}),resolves:kind==='ADJUDICATION'?consensus?.annotations.map(r=>r.id):[],
    }]})}));
  };
  return <details className="stage-detail"><summary>人工标注与 Judge 校准</summary>
    <p>人工意见单独保存，不覆盖原判或授予验收通过。标注者名称为自行填写，不代表已核验身份。</p>
    <button className="button secondary" disabled={busy} onClick={()=>void load()}>{view?'刷新复核记录':'加载人工复核'}</button>
    {error&&<p role="alert">{error}</p>}
    {view&&<>
      <p>以下一致率仅针对已人工标注且可比较的判定项，不是整个测试集准确率。未评、分歧和无法验证单独统计。</p>
      {view.summary.filter(s=>s.total).map(s=><p key={s.scope}>{labels[s.scope]}：已标注 {s.reviewed}/{s.total}；分歧 {s.disputed}；机器未判定 {s.machineMissing}；人工无法验证 {s.humanUnverified}；
        一致 {s.agree}/{s.comparable}（{s.agreement===null?'无可比较结果':Math.round(s.agreement*100)+'%'}）。</p>)}
      {!!view.staleRecordCount&&<p>{view.staleRecordCount} 条历史意见绑定旧材料，不计入当前统计。</p>}
      {!!view.calibrations.length&&<details><summary>跨 Judge／重评版本校准</summary>
        <p>复用同一组人工意见；仅比较证据和判据保持一致的重评。不同版本缺失的判定项仍计入覆盖缺口。</p>
        {view.calibrations.map(calibration=><article key={calibration.id}><h5>{calibration.label}</h5>
          <p>原判定项缺失 {calibration.missingTargets} 项；新增未标注 {calibration.additionalTargets} 项。</p>
          {!calibration.compatible?<p>不可直接比较：{calibration.reason}</p>:calibration.summary.filter(s=>s.total).map(s=><p key={s.scope}>{labels[s.scope]}：一致 {s.agree}/{s.comparable}；分歧 {s.disputed}；机器未判定 {s.machineMissing}；人工无法验证 {s.humanUnverified}。</p>)}
          <small>Judge 版本：{calibration.judgeIdentity}</small>
        </article>)}
      </details>}
      {target?<>
        <label>复核判定项<select aria-label="复核判定项" disabled={busy} value={target.id} onChange={event=>{setSelected(event.target.value);setOutcome('UNVERIFIED');setReason('');setRefs('');}}>
          {view.targets.map(t=><option key={t.id} value={t.id}>{t.caseId} · {t.label}</option>)}</select></label>
        <p>机器原判：{target.machine?labels[target.machine]??target.machine:'未形成可比较结论'}；证据路径位于 {target.evidenceRoot}/…</p>
        <label>标注者名称<input disabled={busy} value={reviewer} onChange={event=>setReviewer(event.target.value)}/></label>
        <label>人工结论<select aria-label="人工结论" disabled={busy} value={outcome} onChange={event=>setOutcome(event.target.value)}>{target.outcomes.map(value=><option value={value} key={value}>{labels[value]}</option>)}</select></label>
        <label>复核理由<textarea aria-label="复核理由" disabled={busy} value={reason} onChange={event=>setReason(event.target.value)}/></label>
        <label>证据引用（每行一个路径）<textarea aria-label="证据引用（每行一个路径）" disabled={busy} value={refs} placeholder={target.evidenceRoot+(source.kind==='migration'?'/evidence/output':'/right/output')} onChange={event=>setRefs(event.target.value)}/></label>
        <button className="button secondary" disabled={busy||!reviewer.trim()||!reason.trim()||!refs.trim()} onClick={()=>void submit('ANNOTATION')}>保存人工意见</button>
        {consensus?.disputed&&<button className="button secondary" disabled={busy||!reviewer.trim()||!reason.trim()||!refs.trim()} onClick={()=>void submit('ADJUDICATION')}>提交争议复核结论</button>}
        {consensus?.annotations.map(item=><p key={item.id}>{item.reviewer} · {labels[item.outcome]}：{item.reason}</p>)}
        {consensus?.decision&&<p>争议复核：{labels[consensus.decision.outcome]} · {consensus.decision.reason}</p>}
      </>:<p>该报告尚无可人工校准的判定项。</p>}
      <details><summary>冻结案例证据（只读）</summary><pre>{JSON.stringify(view.evidence,null,2)}</pre></details>
      <details><summary>导入标注 JSON</summary><p>批量导入使用当前 source、sourceDigest 和 entries；整批校验通过后保存。已有意见的修订需要 supersedes，争议复核需要 resolves。</p>
        <button className="button secondary" disabled={!target||busy} onClick={()=>setImportText(JSON.stringify({source,sourceDigest:view.sourceDigest,entries:[{targetId:target?.id,reviewer:'',kind:'ANNOTATION',outcome:'UNVERIFIED',reason:'',evidenceRefs:[],resolves:[]}]},null,2))}>填写当前报告模板</button>
        <textarea aria-label="人工标注 JSON" disabled={busy} value={importText} onChange={event=>setImportText(event.target.value)}/>
        <button className="button secondary" disabled={busy||!importText.trim()} onClick={()=>void work(async()=>{
          const payload=JSON.parse(importText);
          if(payload.source?.kind!==source.kind||payload.source?.id!==source.id||payload.source?.runId!==('runId' in source?source.runId:undefined))throw new Error('导入标注必须属于当前报告');
          return api<HumanReviewView>('/api/evaluation-reviews',{method:'POST',body:JSON.stringify(payload)});
        })}>导入人工标注</button>
      </details>
      <details><summary>完整复核历史</summary><pre>{JSON.stringify(view.history,null,2)}</pre></details>
    </>}
  </details>;
}
