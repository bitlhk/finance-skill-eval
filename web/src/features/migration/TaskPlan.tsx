import {useState} from 'react';
import {MigrationReusePlan} from '../../MigrationReusePlan';
import {MarkdownContent} from '../../MarkdownContent';
import type {BundleTask} from '../../../../src/migration/tasks/domain/task-model';
import {legacyPlanSections,proseParagraphs} from './legacy-plan';

export function TaskPlan({task,busy,clarify}:{task:BundleTask;busy:boolean;clarify?:(text:string)=>void}) {
  const [text,setText]=useState('');
  const analysis=task.analysis;if(!analysis)return null;
  const revision=task.planRevisions?.find(item=>item.id===task.planRevisionId);
  const index=task.planRevisions?.findIndex(item=>item.id===task.planRevisionId)??-1;
  const previous=index>0?task.planRevisions?.[index-1]:undefined;
  if(analysis.plan) return <div className="restored-plan"><MigrationReusePlan proposal={{proposalId:revision?.id??task.id,inputDigest:task.currentPlanDigest??'',sourceDigest:task.source.digest,createdAt:revision?.createdAt??task.createdAt,
    design:analysis.plan,...(task.planApproved?{approvedAt:revision?.approvedAt}:{}),previousDesign:previous?.analysis.plan,clarification:revision?.clarification}}
    members={task.source.members} busy={busy} clarify={clarify}/></div>;
  const sections=legacyPlanSections(analysis);
  const paragraphs=(lines:string[])=>lines.map((line,index)=><MarkdownContent key={index} compact content={line}/>);
  return <section className="diagnosis-plan restored-plan" aria-label="可复用迁移方案">
    <header><h3>可复用迁移方案</h3><span className="diagnosis-status">{task.planApproved?'方案已确认':'等待确认方案'}</span></header>
    <p className="diagnosis-plan-note">原记录保留完整说明；未单独记录的方案字段会明确标注。</p>
    <h4>复用范围</h4>{paragraphs(sections.scope)}
    <div className="diagnosis-plan-grid">
      <article><h4>具体改造</h4>{sections.changes.length?paragraphs(sections.changes):analysis.changes.map((change,index)=><div key={index}><strong>改造 {index+1}</strong>{paragraphs(proseParagraphs(change.reason))}<details><summary>涉及文件</summary>{change.paths.map(path=><p key={path}><code>{path}</code></p>)}</details></div>)}</article>
      <article><h4>运行条件与依赖</h4>{sections.conditions.length?paragraphs(sections.conditions):<p>原记录未单独保存运行条件与依赖，请结合完整说明核对。</p>}</article>
      <article><h4>验收方式</h4>{sections.acceptance.length?paragraphs(sections.acceptance):<p>原记录未单独保存验收步骤，不能据此认定已经验证。</p>}<p className="diagnosis-plan-note">这些是方案说明，不代表测试已经通过。</p></article>
    </div>
    <details><summary>保留的业务行为与源码依据</summary>{sections.preservedBehavior.length?paragraphs(sections.preservedBehavior):<p>原记录未单独保存保留行为清单。</p>}<p>原记录未保存可定位的源码引用片段。</p></details>
    <details><summary>原始完整方案</summary>{paragraphs(proseParagraphs(analysis.summary))}{analysis.changes.map((change,index)=><div key={index}><h4>原始改造说明 {index+1}</h4>{paragraphs(proseParagraphs(change.reason))}{change.paths.map(path=><p key={path}><code>{path}</code></p>)}</div>)}</details>
    {clarify&&<details><summary>补充说明并调整方案</summary><label>方案补充说明<textarea aria-label="方案补充说明" maxLength={4000} value={text} onChange={e=>setText(e.target.value)} disabled={busy}/></label><button className="button secondary" disabled={busy||!text.trim()} onClick={()=>clarify(text.trim())}>补充说明并重新规划</button></details>}
  </section>;
}
