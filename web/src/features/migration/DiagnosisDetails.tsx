import {useState} from 'react';
import {FileText,Network,Settings2,Wrench} from 'lucide-react';
import type {BundleTask} from '../../../../src/migration/tasks/domain/task-model';
import type {TaskDiagnosis} from '../../../../src/migration/tasks/domain/task-diagnosis';
import {MarkdownContent} from '../../MarkdownContent';
import {legacyChangeCards,legacyPlanSections,proseParagraphs} from './legacy-plan';

const forms={MCP:'MCP 工具',SCRIPT:'独立脚本',CLI:'命令行工具',KEEP:'保留现有形式',UNCONFIRMED:'待确认'};
const owners={RUNTIME:'运行环境提供',TOOL:'随工具交付',UNKNOWN:'归属待确认'};
const actions={INJECT:'运行时注入',PACKAGE:'随包安装',MOVE_TO_RUNTIME:'移至运行环境',KEEP:'保持现状',CONFIRM:'需要确认'};
const content=(text:string)=><MarkdownContent compact content={text}/>;
function SourceEvidence({items}:{items:Array<{path:string;snippet:string}>}){
  return <details className="stage-detail"><summary>查看源码依据</summary>{items.map((item,i)=><div key={i}><small>{item.path}</small><pre>{item.snippet}</pre></div>)}</details>;
}
function ToolDetail({tool,task,busy,clarify}:{tool:TaskDiagnosis['tools'][number];task:BundleTask;busy:boolean;clarify?:(value:string)=>void}){
  const [form,setForm]=useState(tool.targetForm),[language,setLanguage]=useState(tool.language);
  const dependencies=task.analysis!.diagnosis!.dependencies.filter(item=>item.toolIds.includes(tool.id));
  const selection=task.analysis?.standardization?.tools.find(item=>item.toolId===tool.id);
  return <article className="diagnosis-tool change-detail">
    <header className="diagnosis-tool-header"><div><h3>{tool.name}</h3><p className="plan-members">{tool.memberIds.length?tool.memberIds.map(id=>task.source.members.find(item=>item.id===id)?.skillId??id).join('、'):'整个工程（共享）'}</p></div><span className="stage-badge">{forms[tool.targetForm]} · {tool.language}</span></header>
    <p className="change-paths">{tool.sourcePaths.map(path=><code key={path}>{path}</code>)}</p>
    <div className="change-comparison"><section><h4>当前实现</h4>{content(tool.currentBehavior)}</section><section><h4>为什么需要改</h4>{content(tool.problem)}</section></div>
    <h4>迁移方案</h4><p>{tool.reason}</p>
    {selection&&<section className="change-item"><h4>形式选择与成本</h4><p>{selection.action==='KEEP'?'保留现有形式':selection.action==='ADAPT'?'补齐独立调用边界':'转换交付形式'}：{selection.recommendation}</p>
      <div className="change-comparison">{selection.alternatives.map(option=><section key={option.form}><h5>{forms[option.form]} · {option.feasible?'可行':'不适合'}</h5><p>{option.reason}</p><ul className="change-steps"><li>改造：{option.changeCost}</li><li>部署：{option.deploymentCost}</li><li>维护：{option.maintenanceCost}</li></ul></section>)}</div>
      {!!selection.assumptions.length&&<p>选型前提：{selection.assumptions.join('；')}</p>}
      <details className="stage-detail"><summary>调用约定与保留能力</summary><p>{selection.contract.invocation}</p><p>配置：{selection.contract.configuration}</p><p>错误：{selection.contract.errors}</p><p>状态：{selection.contract.state}</p>
        <ul>{task.analysis!.standardization!.requirements.filter(r=>r.toolIds.includes(tool.id)).map(r=><li key={r.id}>{r.kind==='RUNTIME'?'运行条件':'业务要求'}：{r.statement}</li>)}</ul></details>
    </section>}
    {tool.changes.map((change,i)=><section className="change-item" key={i}><h4>{i+1}. {change.title}</h4><div className="change-comparison"><section><h5>改造前</h5>{content(change.before)}</section><section><h5>改造后</h5>{content(change.after)}</section></div><h5>实施步骤</h5><ol className="change-steps">{change.steps.map((step,j)=><li key={j}>{content(step)}</li>)}</ol></section>)}
    {!tool.changes.length&&<p>此工具无需代码改造，按上方迁移形式保留。</p>}
    {!!tool.preservedBehavior.length&&<section className="change-preserved"><h4>保持不变</h4><ul>{tool.preservedBehavior.map((item,i)=><li key={i}>{item}</li>)}</ul></section>}
    {!!tool.callChain.length&&<><h4 className="diagnosis-section-title"><Network size={16}/>调用链路</h4><div className="diagnosis-flow">{tool.callChain.map((node,i)=><div className="diagnosis-flow-node" key={i}><span className="diagnosis-flow-index">{i+1}</span><strong>{node.title}</strong><p>{node.detail}</p><SourceEvidence items={node.evidence}/></div>)}</div></>}
    {!!dependencies.length&&<p>相关依赖：{dependencies.map(item=>item.name+'（'+owners[item.owner]+'）').join('、')}。配置要求见下方。</p>}
    <SourceEvidence items={tool.evidence}/>
    {clarify&&<details className="stage-detail"><summary>调整此工具的迁移形式</summary><div className="migration-fields"><label>转换形式<select disabled={busy} value={form} onChange={e=>setForm(e.target.value as typeof form)}>{Object.entries(forms).filter(([value])=>!selection||['SCRIPT','MCP','CLI'].includes(value)).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>实现语言<input disabled={busy} value={language} onChange={e=>setLanguage(e.target.value)}/></label></div><button className="button secondary" disabled={busy||!language.trim()||form===tool.targetForm&&language===tool.language} onClick={()=>clarify(`请调整工具 ${tool.name}（${tool.id}）的方案：转换形式为${forms[form]}，实现语言为${language.trim()}。保留原业务行为，重新核对成本与依赖，同时更新标准化选型、诊断与完整方案；无法满足时明确说明原因。`)}>更新此工具方案</button><p>更新后需要重新确认方案，才会实施改造。</p></details>}
  </article>;
}
export function DiagnosisDetails({task,busy,clarify}:{task:BundleTask;busy:boolean;clarify?:(value:string)=>void}){
  const analysis=task.analysis;if(!analysis)return null;
  const d=analysis.diagnosis,legacy=legacyChangeCards(analysis),sections=legacyPlanSections(analysis);
  const preserved=analysis.plan?.preservedBehavior??sections.preservedBehavior;
  return <div className="diagnosis-details restored-plan">
    <section className="diagnosis-plan" aria-label="改造内容总览"><header><h3>改造内容总览</h3></header><div className="diagnosis-plan-grid">
      <article><div className="diagnosis-plan-title"><FileText size={18}/><h4>Skill 指令</h4></div><ul>{d?d.skillChanges.map((item,i)=><li key={i}><strong>{item.memberIds.length?item.memberIds.map(id=>task.source.members.find(member=>member.id===id)?.skillId??id).join('、'):'工程指令'} · {item.action==='KEEP'?'保留原有指令':'修改指令说明'}</strong><span>{item.paths.join('、')}</span><span>{item.reason}</span></li>):task.source.members.map(member=><li key={member.id}><strong>{member.skillId}</strong><span>{member.skillFile}</span></li>)}</ul>{!d&&<p className="diagnosis-plan-note">具体保留内容见下方原方案说明。</p>}</article>
      <article><div className="diagnosis-plan-title"><Wrench size={18}/><h4>工具改造</h4></div><ul>{d?d.tools.map(tool=><li key={tool.id}><strong>{tool.name} → {forms[tool.targetForm]}</strong><span>{tool.language} · {tool.sourcePaths.join('、')}</span></li>):legacy.map((item,i)=><li key={i}><strong>{item.title}</strong><span>{item.paths.join('、')}</span></li>)}</ul>{d&&!d.tools.length&&<p>未识别到需要迁移的工具实现。</p>}</article>
      <article><div className="diagnosis-plan-title"><Settings2 size={18}/><h4>运行与依赖配置</h4></div>{d?<ul>{d.dependencies.map(dep=><li key={dep.id}><strong>{dep.name}<span className="config-state">{actions[dep.action]}</span></strong><span>{owners[dep.owner]}</span></li>)}</ul>:<p>原记录未逐项列出依赖归属，运行条件保留在下方。</p>}{d&&!d.dependencies.length&&<p>未识别到额外依赖。</p>}<p className="diagnosis-plan-note">所需条件不代表目标环境已具备。</p></article>
    </div></section>
    {d?d.tools.map(tool=><ToolDetail key={(task.planRevisionId??task.id)+tool.id} tool={tool} task={task} busy={busy} clarify={clarify}/>):<>
      {legacy.map((item,i)=><article className="diagnosis-tool change-detail" key={i}><header className="diagnosis-tool-header"><h3>{i+1}. {item.title}</h3></header><p className="change-paths">{item.paths.map(path=><code key={path}>{path}</code>)}</p><h4>改造方案</h4><ul className="change-steps">{item.points.map((point,j)=><li key={j}>{content(point)}</li>)}</ul></article>)}
      {!!preserved.length&&<section className="diagnosis-tool"><h3>保持不变的业务内容</h3><ul className="change-steps">{preserved.flatMap(item=>proseParagraphs(item)).map((item,i)=><li key={i}>{content(item)}</li>)}</ul></section>}
      {!!(analysis.plan?.conditions??sections.conditions).length&&<section className="diagnosis-tool"><h3>运行条件与待验证事项</h3><ul className="change-steps">{(analysis.plan?.conditions??sections.conditions).flatMap(item=>proseParagraphs(item,'。；，')).map((item,i)=><li key={i}>{content(item)}</li>)}</ul></section>}
    </>}
    {!!d?.dependencies.length&&<section className="diagnosis-shared"><h3>运行与依赖配置</h3>{d.dependencies.map(dep=><article className="diagnosis-dependency" key={dep.id}><h4>{dep.name} · {owners[dep.owner]}</h4><p>{dep.purpose}</p><div className="change-comparison"><section><h5>如何提供</h5>{content(dep.configuration)}</section><section><h5>如何验证</h5>{content(dep.verification)}</section></div><SourceEvidence items={dep.evidence}/></article>)}</section>}
  </div>;
}
