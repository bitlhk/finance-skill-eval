import type {assessmentStability} from '../../src/evaluation/application/repeated-assessment';
export function AssessmentStability({items}:{items?:ReturnType<typeof assessmentStability>}){
  if(!items?.length)return null;
  return <section><h5>Judge 重复评分一致性</h5><p>衡量固定材料的判定波动，不代表 Agent 业务运行稳定性，也不证明判定正确。</p>
    {items.map(item=><p key={item.caseId}>{item.caseId}：完成 {item.assessed}/{item.attempts} 次，无法判定或异常 {item.unavailable} 次；
      有效判定一致率 {item.agreement===null?'无法计算':`${Math.round(item.agreement*100)}%`}。
      {Object.entries(item.counts).map(([outcome,count])=>`${outcome} ${count} 次`).join('，')}</p>)}</section>;
}
