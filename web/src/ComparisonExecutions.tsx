import type {EvaluationJob} from './types';
import {MarkdownContent} from './MarkdownContent';
import {EvaluationEvidence} from './EvaluationEvidence';

export function ComparisonExecutions({job}:{job:EvaluationJob}){
  if(!job.executionAttempts)return null;
  const count=job.configuration.executionRepetitions??1;
  return <section className="question-receipt">
    <h3>业务重复运行 · 计划 {count} 次</h3>
    <p>下方主报告为最近一次完成的运行，不代表整组结论。偏好胜出不等于业务达标。</p>
    {job.executionRepetitionsStopped&&<p>{job.executionRepetitionsStopped}</p>}
    {Array.from({length:count},(_,index)=>{
      const attempt=job.executionAttempts?.find(a=>a.index===index);
      const status=attempt?.status==='COMPLETED'?'已形成报告':attempt?.status==='FAILED'?'执行失败':attempt?(job.status==='interrupted'?'已中断':'执行中'):'未执行';
      return <details key={index}>
        <summary>第 {index+1} 次 · {status}</summary>
        {attempt?.error&&<p>{attempt.error}</p>}
        {attempt?.report&&<>
          <p>{attempt.report.summary.headline}</p>
          {attempt.report.cases.map(c=><article className="result-case" key={c.caseId}>
            <h4>{c.name}</h4>
            <div className="answer-grid">
              <article><strong>A</strong><MarkdownContent content={c.left.output}/></article>
              <article><strong>B</strong><MarkdownContent content={c.right.output}/></article>
            </div>
            <p>{c.judge?.summary??c.judgeError??'未形成判定'}</p>
            <div className="answer-grid">
              <EvaluationEvidence methods={c.methodResults?.left} evidence={c.left}/>
              <EvaluationEvidence methods={c.methodResults?.right} evidence={c.right}/>
            </div>
          </article>)}
          <details><summary>本次完整证据</summary><pre>{JSON.stringify(attempt.report,null,2)}</pre></details>
        </>}
      </details>;
    })}
  </section>;
}
