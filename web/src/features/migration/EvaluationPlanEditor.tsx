import {useEffect,useState} from 'react';
import {evaluationPlanSchema,type EvaluationPlan} from '../../../../src/evaluation/domain/evaluation-plan';

type Check=EvaluationPlan['checks'][number];
function ExpectedValue({value,onChange,disabled}:{value:unknown;onChange(value:unknown):void;disabled:boolean}){
  const encoded=JSON.stringify(value);
  const [draft,setDraft]=useState(encoded),[error,setError]=useState('');
  useEffect(()=>{setDraft(encoded);setError('');},[encoded]);
  return <label>期望值（JSON，例如 42、"成功" 或 ["A","B"]）<input disabled={disabled} value={draft} onChange={event=>{
    setDraft(event.target.value);try{const parsed=JSON.parse(event.target.value);setError('');onChange(parsed);}catch{setError('请输入有效的 JSON；当前修改尚未应用');}
  }}/>{error&&<small role="alert">{error}</small>}</label>;
}
/** Edits the same persisted plan used by all evaluators; no separate UI grading protocol. */
export function EvaluationPlanEditor({plan,onChange,disabled}:{plan?:EvaluationPlan;onChange(plan:EvaluationPlan):void;disabled:boolean}){
  const parsed=evaluationPlanSchema.safeParse(plan??{version:'1',checks:[]});
  if(!parsed.success)return <p role="alert">评测方案有不完整或不支持的字段，请在下方高级设置修正；原始内容已保留。</p>;
  const current=parsed.data;
  const update=(index:number,change:Partial<Check>)=>onChange({...current,checks:current.checks.map((check,i)=>i===index?{...check,...change}:check)});
  return <details className="stage-detail"><summary>规则、脚本与状态检查（{current.checks.length} 项）</summary>
    <p>多项检查复用一次业务执行。强制项失败或无法验证时不能通过验收；脚本运行需要已配置的隔离执行环境。</p>
    <label>方案版本<input disabled={disabled} value={current.version} onChange={event=>onChange({...current,version:event.target.value})}/></label>
    {current.checks.map((check,index)=><article className="stage-tool-card" key={check.id}>
      <h5>{check.id}</h5>
      <label>检查方式<select disabled={disabled} value={check.kind} onChange={event=>{
        const kind=event.target.value as Check['kind'];update(index,{kind,rule:kind==='RULE'?{operation:'equals',reference:'/output',expected:''}:undefined,
          script:kind==='RULE'?undefined:'import json\ne = json.load(open("evidence.json"))\n# 检查证据后输出 checks；不要用执行成功代替业务通过\n'});
      }}><option value="RULE">确定性规则</option><option value="SCRIPT">Python 脚本</option><option value="STATE">业务状态快照</option></select></label>
      <label><input type="checkbox" disabled={disabled} checked={check.required} onChange={event=>update(index,{required:event.target.checked})}/>必须通过</label>
      <label>检查版本<input disabled={disabled} value={check.version} onChange={event=>update(index,{version:event.target.value})}/></label>
      <label>超时（秒）<input type="number" min={1} max={120} disabled={disabled} value={check.timeoutMs/1000} onChange={event=>update(index,{timeoutMs:Number(event.target.value)*1000})}/></label>
      {check.rule&&<>
        <label>证据字段<input disabled={disabled} value={check.rule.reference} onChange={event=>update(index,{rule:{...check.rule!,reference:event.target.value}})}/></label>
        <label>判断方法<select aria-label="判断方法" disabled={disabled} value={check.rule.operation} onChange={event=>{
          const reference=check.rule!.reference;
          const operation=event.target.value as NonNullable<Check['rule']>['operation'];
          const rule:NonNullable<Check['rule']>=operation==='numeric_tolerance'?{operation,reference,expected:0,absoluteTolerance:0.01,relativeTolerance:0}
            :operation==='set_equals'?{operation,reference,expected:[]}:operation==='exists'?{operation,reference}:{operation,reference,expected:''};
          update(index,{rule});
        }}><option value="equals">完全相等</option><option value="contains">包含文字</option><option value="exists">证据存在</option><option value="numeric_tolerance">数值容差</option><option value="set_equals">集合相等</option></select></label>
        {'expected' in check.rule&&<ExpectedValue key={check.rule.operation} disabled={disabled} value={check.rule.expected} onChange={expected=>update(index,{rule:{...check.rule!,expected} as Check['rule']})}/>}
        {check.rule.operation==='numeric_tolerance'&&<label>绝对误差容限<input type="number" min={0} step="any" disabled={disabled} value={check.rule.absoluteTolerance}
          onChange={event=>update(index,{rule:{...check.rule!,absoluteTolerance:Number(event.target.value)} as Check['rule']})}/></label>}
      </>}
      {check.kind!=='RULE'&&<label>验证脚本<textarea disabled={disabled} value={check.script??''} spellCheck={false} onChange={event=>update(index,{script:event.target.value})}/></label>}
      <label>必要证据（每行一个 JSON pointer）<textarea disabled={disabled} value={check.evidenceRefs.join('\n')} placeholder="/state/booking/status"
        onChange={event=>update(index,{evidenceRefs:event.target.value.split('\n').map(s=>s.trim()).filter(Boolean)})}/></label>
      <button className="button secondary" disabled={disabled} onClick={()=>onChange({...current,checks:current.checks.filter((_,i)=>i!==index)})}>移除检查</button>
    </article>)}
    <button className="button secondary" disabled={disabled||current.checks.length>=20} onClick={()=>onChange({...current,checks:[...current.checks,
      {id:'check-'+crypto.randomUUID().slice(0,8),version:'1',kind:'RULE',required:true,evidenceRefs:[],timeoutMs:60000,rule:{operation:'equals',reference:'/output',expected:''}}]})}>添加检查</button>
  </details>;
}
