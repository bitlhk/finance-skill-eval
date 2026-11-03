import {useState} from 'react';
import {api} from './api-client';
import type {EvaluationJob} from '../../src/shared/contracts/evaluation-job';
import {EvaluationEvidence} from './EvaluationEvidence';
import {AssessmentStability} from './AssessmentStability';
import {HumanReviewPanel} from './HumanReviewPanel';
type Record=NonNullable<EvaluationJob['rescorings']>[number];
export function ComparisonRescoring({jobId,records=[]}:{jobId:string;records?:Record[]}){
  const [saved,setSaved]=useState(records),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [repetitions,setRepetitions]=useState(1),[alternateOrder,setAlternateOrder]=useState(false);
  return <section className="stage-secondary-card">
    <label>重复评判次数<select aria-label="重复评判次数" value={repetitions} disabled={busy} onChange={event=>setRepetitions(Number(event.target.value))}>{[1,2,3,4,5].map(n=><option value={n} key={n}>{n}</option>)}</select></label>
    <label><input type="checkbox" disabled={busy||repetitions<2} checked={alternateOrder&&repetitions>1} onChange={event=>setAlternateOrder(event.target.checked)}/>交替交换 A/B 展示顺序（仅支持双侧质量 Judge）</label>
    <button className="button secondary" disabled={busy} onClick={async()=>{
    setBusy(true);setError('');try{
      const record=await api<Record>(`/api/runs/${jobId}/rescore`,{method:'POST',body:JSON.stringify({repetitions,alternateOrder:alternateOrder&&repetitions>1})});setSaved(current=>[...current,record]);
    }catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  }}>{busy?'重新评判中…':'使用已保存证据重新评判'}</button>
    <p>只重新检查历史输出与证据，不调用业务 Agent，不覆盖原报告。</p>
    <HumanReviewPanel source={{kind:'comparison',id:jobId}}/>
    {error&&<p role="alert">{error}</p>}
    {saved.map(record=><details key={record.id}><summary>重新评判 · {record.createdAt}</summary>
      {(record.repetitions??1)>1&&<><AssessmentStability items={record.stability}/><details><summary>每次评分与展示顺序</summary><pre>{JSON.stringify(record.attempts,null,2)}</pre></details><p>以下为首次评判详情。</p></>}
      {record.cases.map(item=><article key={item.caseId}>
      <p>{item.name} · {item.judge?.summary??item.judgeError}</p><div className="answer-grid"><EvaluationEvidence methods={item.methodResults?.left} evidence={item.left}/><EvaluationEvidence methods={item.methodResults?.right} evidence={item.right}/></div>
    </article>)}</details>)}
  </section>;
}
