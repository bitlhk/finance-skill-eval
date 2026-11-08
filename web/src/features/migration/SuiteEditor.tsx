import type { BundleTask } from "../../../../contracts/platform/responses";
import {useState} from 'react';
import {EvaluationPlanEditor} from './EvaluationPlanEditor';
import {MIGRATION_CASE_LIMIT} from './form-limits';

type Suite = NonNullable<BundleTask['suite']>;

// A form must never replace imported data it cannot represent. Extra fields,
// fixtures and independent acceptance cases remain in the original JSON.
export function editableSuite(value: string): Suite | null {
  try {
    const suite = JSON.parse(value);
    if (!suite || typeof suite.name !== 'string' || !Array.isArray(suite.cases) || !suite.cases.length) return null;
    if (!suite.cases.every((item: Suite['cases'][number]) => item && typeof item.id === 'string' &&
      typeof item.input === 'string' && Array.isArray(item.criteria) && item.criteria.every(c => typeof c === 'string') && !item.turns?.length)) return null;
    return suite;
  } catch { return null; }
}

/** Validate a selected file before replacing the editable draft. */
export function parseSuiteImport(value:string):string {
  let parsed:unknown;
  try{parsed=JSON.parse(value);}catch{throw new Error('文件不是有效的 JSON，现有草稿未改变。');}
  const suite=parsed as {name?:unknown;cases?:unknown};
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||typeof suite.name!=='string'||!suite.name.trim()
    ||!Array.isArray(suite.cases)||!suite.cases.length||suite.cases.length>MIGRATION_CASE_LIMIT
    ||suite.cases.some((item:unknown)=>{
      if(!item||typeof item!=='object'||Array.isArray(item))return true;
      const c=item as {id?:unknown;input?:unknown;criteria?:unknown};
      return typeof c.id!=='string'||!c.id.trim()||typeof c.input!=='string'||!c.input.trim()
        ||!Array.isArray(c.criteria)||!c.criteria.length||c.criteria.some(value=>typeof value!=='string'||!value.trim());
    }))
    throw new Error('测试集格式或案例内容不符合要求，现有草稿未改变。');
  return JSON.stringify(parsed,null,2);
}

export function SuiteEditor({ value, onChange, disabled,onSuggest }: { value: string; onChange(value: string): void; disabled: boolean;onSuggest?:()=>void }) {
  const [importError,setImportError]=useState('');
  const suite = editableSuite(value);
  const update = (next: Suite) => onChange(JSON.stringify(next, null, 2));
  return <section className="stage-secondary-card">
    <h4>用真实任务验证效果</h4>
    <p>填写希望 Skill 完成的任务，以及判断结果是否正确的标准。</p>
    {onSuggest&&<button className="button secondary" type="button" disabled={disabled} onClick={onSuggest}>让 Agent 设计案例</button>}
    {suite ? <>
      <label>测试名称<input disabled={disabled} value={suite.name} onChange={e => update({ ...suite, name: e.target.value })}/></label>
      <label>业务运行次数<select aria-label="业务运行次数" disabled={disabled} value={suite.executionRepetitions??1} onChange={event=>update({...suite,executionRepetitions:Number(event.target.value)})}>
        {[1,2,3,4,5].map(n=><option key={n} value={n}>{n}</option>)}</select></label>
      {(suite.executionRepetitions??1)>1&&<p>每次都会实际调用业务 Agent。每个案例需要可核验的状态恢复，或由你明确确认只读；这与报告中的重复评分不同。</p>}
      {suite.cases.map((item, index) => <article className="stage-tool-card" key={index}>
        <h4>测试案例 {index + 1}</h4>
        <label><input type="checkbox" disabled={disabled} checked={item.repeatSafety==='read_only'} onChange={event=>update({...suite,cases:suite.cases.map((c,i)=>i===index?{...c,repeatSafety:event.target.checked?'read_only':undefined}:c)})}/>确认此案例只读，不修改外部业务状态</label>
        <label><input type="checkbox" disabled={disabled} checked={!!item.stateFixture} onChange={event=>update({...suite,cases:suite.cases.map((c,i)=>i===index?{...c,stateFixture:event.target.checked?{fixtureId:'',version:'',initialStateDigest:''}:undefined}:c)})}/>使用测试环境中的业务初态与恢复</label>
        {item.stateFixture&&<div className="bundle-fields">
          <p>由测试环境提供已登记的初态及摘要；不在这里填写凭据或生产重置命令。</p>
          {(['fixtureId','version','initialStateDigest'] as const).map(field=><label key={field}>{field==='fixtureId'?'测试初态标识':field==='version'?'初态版本':'初态 SHA-256 摘要'}
            <input disabled={disabled} value={item.stateFixture![field]} onChange={event=>update({...suite,cases:suite.cases.map((c,i)=>i===index?{...c,stateFixture:{...c.stateFixture!,[field]:event.target.value}}:c)})}/></label>)}
        </div>}
        <label>任务内容<textarea disabled={disabled} value={item.input} placeholder="例如：查询明天下午可容纳 6 人的空闲会议室。"
          onChange={e => update({ ...suite, cases: suite.cases.map((c, i) => i === index ? { ...c, input: e.target.value } : c) })}/></label>
        <label>场景与设计说明（可选）<textarea disabled={disabled} maxLength={2000} value={item.rationale??''} placeholder="说明该案例覆盖的场景和设计原因"
          onChange={e => update({ ...suite, cases: suite.cases.map((c, i) => i === index ? { ...c, rationale: e.target.value || undefined } : c) })}/></label>
        <small>用于理解案例，不作为业务输入或判断标准。</small>
        <label>预期结果（每行一条）<textarea disabled={disabled} value={item.criteria.join('\n')} placeholder="填写可以核验的结果或要求"
          onChange={e => update({ ...suite, cases: suite.cases.map((c, i) => i === index ? { ...c, criteria: e.target.value.split('\n'),
            ...(c.criterionScopes?{criterionScopes:e.target.value.split('\n').map((_,j)=>c.criterionScopes?.[j]??'execution')}:{}) } : c) })}/></label>
        {item.criteria.map((criterion,criterionIndex)=><label key={criterionIndex}>标准 {criterionIndex+1} 的评判范围
          <select disabled={disabled} value={item.criterionScopes?.[criterionIndex]??'execution'} onChange={event=>update({...suite,cases:suite.cases.map((c,i)=>i===index?{
            ...c,criterionScopes:c.criteria.map((_,j)=>j===criterionIndex?event.target.value as 'answer'|'execution':c.criterionScopes?.[j]??'execution'),
          }:c)})}><option value="answer">回答质量（隔离调用过程）</option><option value="execution">执行与业务正确性（读取实际证据）</option></select>
          <small>{criterion}</small></label>)}
        <button className="button secondary" disabled={disabled || suite.cases.length === 1}
          onClick={() => update({ ...suite, cases: suite.cases.filter((_, i) => i !== index) })}>移除案例</button>
        <EvaluationPlanEditor plan={item.evaluationPlan} disabled={disabled} onChange={evaluationPlan=>update({...suite,cases:suite.cases.map((c,i)=>i===index?{...c,evaluationPlan}:c)})}/>
      </article>)}
      <button className="button secondary" disabled={disabled || suite.cases.length >= MIGRATION_CASE_LIMIT}
        onClick={() => update({ ...suite, cases: [...suite.cases, { id: crypto.randomUUID(), input: '', criteria: [''] }] })}>添加案例</button>
      {!!suite.holdoutCases?.length && <p>另有 {suite.holdoutCases.length} 个独立验收案例，已保留，可在高级设置中查看。</p>}
    </> : <p role="status">当前测试内容含多轮对话或格式需要检查，请在高级设置中编辑；原始内容已保留。</p>}
    <details className="stage-detail" open={!suite}><summary>高级设置：导入与编辑测试集</summary>
      <p>可编辑完整测试集，包含测试文件、多轮对话和独立验收案例。每个案例的 evaluationPlan 可补充规则、Python 验证脚本和状态检查；未提供时沿用现有模型评判。</p>
      <p>文件载入时检查基本格式，保存时检查完整测试集；请选择要替换当前草稿的文件。</p>
      <label>从 JSON 文件载入草稿（替换当前编辑内容）<input type="file" accept=".json,application/json" disabled={disabled} onChange={event=>{
        const target=event.currentTarget,file=target.files?.[0];if(!file)return;
        void (async()=>{try{
          if(file.size>2*1024*1024)throw new Error('文件超过 2 MB，现有草稿未改变。');
          onChange(parseSuiteImport(await file.text()));setImportError('');
        }catch(reason){setImportError(reason instanceof Error?reason.message:'文件读取失败，现有草稿未改变。');}
        finally{target.value='';}})();
      }}/></label>
      {importError&&<p role="alert">{importError}</p>}
      <label>验收测试集 JSON<textarea aria-label="验收测试集 JSON" disabled={disabled} className="bundle-suite" value={value} onChange={e => onChange(e.target.value)} spellCheck={false}/></label>
    </details>
  </section>;
}
