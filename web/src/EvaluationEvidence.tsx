import type {EvaluationMethodResult} from '../../src/evaluation/application/evaluation-method';
import type {RuntimeExecutionEvidence} from '../../src/contracts';
const labels:Record<string,string>={PASS:'通过',FAIL:'未通过',UNVERIFIED:'证据不足',ERROR:'评判异常',SKIP:'未执行'};
export function EvaluationEvidence({methods,evidence}:{methods?:EvaluationMethodResult[];evidence?:Partial<Pick<RuntimeExecutionEvidence,'metadata'>>}){
  const telemetry=evidence?.metadata?.telemetry as {status?:string;otlp?:unknown}|undefined;
  const process=evidence?.metadata?.process as {status?:string;reason?:string;scopes?:string[];records?:unknown[]}|undefined;
  const artifacts=evidence?.metadata?.artifacts as Array<{path:string;content?:string}>|undefined;
  const assessed=methods?.filter(m=>m.status==='PASS'||m.status==='FAIL').length??0;
  const caseState=evidence?.metadata?.caseState as {status?:string}|undefined;
  return <section className="stage-secondary-card">
    <h5>评判与证据</h5>
    {caseState&&<details><summary>业务状态：{caseState.status==='COMPLETE'?'初态、采集与恢复均已核验':'未完整核验，不视为已恢复'}</summary><pre>{JSON.stringify(caseState,null,2)}</pre></details>}
    {methods?.length?<p>已完成 {assessed}/{methods.length} 项评判；其余项目不计为通过。</p>:<p>此记录没有分项评判信息。</p>}
    {methods?.map(method=><details key={method.methodId}><summary>{method.methodId} · {labels[method.status]}</summary>
      <p>{method.reason}</p>{method.checks.map(check=><p key={check.id}>{labels[check.status]} · {check.reason}
        {!!check.evidenceRefs?.length&&<small> 依据：{check.evidenceRefs.join('、')}</small>}</p>)}</details>)}
    <p>调用过程：{(process??telemetry)?.status==='COMPLETE'?'已收集（限声明范围）':(process??telemetry)?.status==='PARTIAL'?'部分记录，不能证明未发生其他调用':'未提供可验证的调用过程'}</p>
    {process&&<details><summary>查看中间过程{process.records?`（${process.records.length} 条）`:''}</summary>
      <p>采集范围：{process.scopes?.map(scope=>({tools:'工具调用',models:'模型调用',messages:'消息',events:'事件'}[scope]??scope)).join('、')||'未声明'}。采集状态不代表业务是否通过。</p>
      {process.reason&&<p>记录说明：{process.reason}</p>}<pre>{JSON.stringify(process,null,2)}</pre></details>}
    {!!telemetry?.otlp&&<details><summary>查看调用记录</summary><pre>{JSON.stringify(telemetry.otlp,null,2)}</pre></details>}
    {evidence?.metadata?.artifactValidation==='INVALID'&&<p>产物结构或摘要不一致，未作为有效证据。</p>}
    {Array.isArray(artifacts)&&artifacts.filter(artifact=>artifact&&typeof artifact.path==='string').map((artifact,index)=><details key={index}><summary>产物：{artifact.path}</summary><pre>{typeof artifact.content==='string'?artifact.content:'未收集内容'}</pre></details>)}
  </section>;
}
