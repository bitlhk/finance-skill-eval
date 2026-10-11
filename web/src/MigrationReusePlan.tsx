import {CheckCircle2,AlertTriangle} from 'lucide-react';
import {useEffect,useState} from 'react';
import type {MigrationReuseProposal,ReuseConformance} from '../../src/migration/domain/migration-reuse-design';
import type {ReusePlannerTelemetry} from '../../src/migration/domain/migration-reuse-telemetry';
import type {ReuseDesign} from '../../src/migration/domain/migration-reuse-design';

const designSections:Record<keyof ReuseDesign,string>={scope:'复用范围',preservedBehavior:'保留的业务行为',sourceCouplings:'源码耦合',changes:'具体改造',dependencies:'依赖配置',conditions:'运行条件',unresolvedQuestions:'待确认事项',acceptanceChecks:'验收方式'};
function describeSection(design:ReuseDesign,key:keyof ReuseDesign):string[]{
  switch(key){
    case 'scope':return [design.scope];
    case 'changes':return design.changes.map(item=>`${item.title}：${item.implementation}`);
    case 'dependencies':return design.dependencies.map(item=>`${item.name}：${item.contract}；${item.configuration}`);
    case 'sourceCouplings':return design.sourceCouplings.map(item=>item.description);
    case 'acceptanceChecks':return design.acceptanceChecks.map(item=>`${item.purpose}：${item.requirement?`${item.requirement}；`:''}${item.procedure}；预期：${item.expectedResult}`);
    default:return design[key];
  }
}

function PlanRevision({proposal}:{proposal:MigrationReuseProposal}){
  const previous=proposal.previousDesign;if(!previous)return null;
  const changed=(Object.keys(designSections) as Array<keyof ReuseDesign>).filter(key=>JSON.stringify(previous[key])!==JSON.stringify(proposal.design[key]));
  return <section aria-label="方案修订"><h4>本次方案更新</h4><p>{changed.length?`已调整：${changed.map(key=>designSections[key]).join('、')}。`:'方案内容未变化。'}{proposal.approvedAt?'本版已确认。':'请核对后重新确认。'}历史测试仍按当时的方案留存，不作为本版通过证据。</p>
    {!!changed.length&&<details><summary>查看修订前后对照</summary>{changed.map(key=><article key={key}><h4>{designSections[key]}</h4><strong>此前</strong>{describeSection(previous,key).map((line,i)=><p key={`old-${i}`}>{line}</p>)}<strong>本次</strong>{describeSection(proposal.design,key).map((line,i)=><p key={`new-${i}`}>{line}</p>)}</article>)}</details>}
  </section>;
}

function ReviewTiming({telemetry}:{telemetry?:ReusePlannerTelemetry}){
  if(!telemetry)return null;
  return <details className="stage-detail"><summary>审查耗时 {Math.round(telemetry.elapsedMs/1000)} 秒 · {telemetry.calls.length} 次模型调用</summary>
    {telemetry.calls.map((call,i)=><p key={`${call.requestId}-${i}`}>第 {i+1} 次：{Math.round(call.elapsedMs/1000)} 秒{call.usage?.totalTokens!==undefined?`，${call.usage.totalTokens} tokens`:''}{call.retryReason?`；${call.retryReason==='OUTPUT_FORMAT'?'输出格式未通过检查':'源码引用未通过检查'}，已重试`:''}</p>)}
  </details>;
}

export function MigrationReusePlan({proposal,stale=false,busy=false,clarify}:{proposal:MigrationReuseProposal|null|undefined;stale?:boolean;busy?:boolean;clarify?:(clarification:string)=>void}){
  const [clarification,setClarification]=useState('');
  useEffect(()=>setClarification(''),[proposal?.proposalId]);
  if(!proposal)return <section className="diagnosis-plan"><h3>可复用迁移方案</h3><p>完成工具选择后生成方案，查看改造内容、运行条件和验收方式。</p></section>;
  const d=proposal.design;
  return <section className="diagnosis-plan" aria-label="可复用迁移方案"><header><h3>可复用迁移方案</h3><span className={`diagnosis-status${stale||d.unresolvedQuestions.length?' attention':''}`}>{stale||d.unresolvedQuestions.length?<AlertTriangle size={14}/>:<CheckCircle2 size={14}/>} {stale?'工具选择已变化，需要更新方案':d.unresolvedQuestions.length?'有待确认事项':proposal.approvedAt?'方案已确认':'等待确认方案'}</span></header>
    <PlanRevision proposal={proposal}/><h4>复用范围</h4><p>{d.scope}</p>
    <div className="diagnosis-plan-grid"><article><h4>具体改造</h4>{d.changes.map(change=><div key={change.id}><strong>{change.title}</strong><p>{change.implementation}</p><details><summary>源码依据</summary>{change.evidence.map((e,i)=><div key={i}><small>{e.path}</small><pre>{e.snippet}</pre></div>)}</details></div>)}</article>
      <article><h4>运行条件与依赖</h4><ul>{d.conditions.map((condition,i)=><li key={i}>{condition}</li>)}</ul>{!!d.dependencies.length&&<details><summary>查看 {d.dependencies.length} 项依赖配置</summary>{d.dependencies.map(dep=><div key={dep.key}><strong>{dep.name}</strong><p>{dep.contract}</p><p>{dep.configuration}</p></div>)}</details>}</article>
      <article><h4>验收方式（{d.acceptanceChecks.length} 项）</h4>{d.acceptanceChecks.map(check=><details key={check.id}><summary>{check.purpose}</summary>{check.requirement&&<p>验证目标：{check.requirement}</p>}<p>{check.procedure}</p><p>预期：{check.expectedResult}</p></details>)}<p className="diagnosis-plan-note">方案确认后实施；这些检查尚未运行。</p></article></div>
    {proposal.clarification&&<details><summary>本次规划的补充说明</summary><p>{proposal.clarification}</p></details>}
    {!!d.unresolvedQuestions.length&&<div role="alert"><h4>确认方案前需要补充</h4><ul>{d.unresolvedQuestions.map((question,i)=><li key={i}>{question}</li>)}</ul>{clarify&&<><label>方案补充说明<textarea aria-label="方案补充说明" value={clarification} maxLength={4000} disabled={busy} onChange={e=>setClarification(e.target.value)}/></label><p>说明本次复用范围或回答待确认事项，不要填写凭证。重新规划后仍需核对并确认方案；原问题和测试记录保留。</p><button className="button secondary" disabled={busy||!clarification.trim()} onClick={()=>clarify(clarification.trim())}>补充说明并重新规划</button></>}</div>}
    <details><summary>保留的业务行为与源码依据</summary><ul>{d.preservedBehavior.map((behavior,i)=><li key={i}>{behavior}</li>)}</ul>{d.sourceCouplings.map((coupling,i)=><div key={i}><p>{coupling.description}</p>{coupling.evidence.map((e,j)=><div key={j}><small>{e.path}</small><pre>{e.snippet}</pre></div>)}</div>)}</details>
  </section>;
}

export function ReuseConformanceSummary({conformance}:{conformance?:ReuseConformance}){
  if(!conformance)return null;
  return <section className="stage-section" aria-label="方案落实检查"><h4><CheckCircle2 size={16}/>已检查方案落实情况</h4><p>产物已逐项审查；运行验收需按方案继续验证。</p><details className="stage-detail"><summary>查看 {conformance.review.changes.length} 项改造检查</summary>{conformance.review.changes.map(change=><p key={change.changeId}>{change.reason}</p>)}</details><ReviewTiming telemetry={conformance.telemetry}/><p>待验证的复用条件：{conformance.acceptanceChecks.length} 项</p></section>;
}
