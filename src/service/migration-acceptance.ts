import type { EvalCase } from '../contracts.js';
import type { EvaluationReport } from '../report.js';

/** This is automatic candidate acceptance, not original-runtime equivalence or human sign-off. */
export function assessMigrationAcceptance(report:EvaluationReport|null,cases:EvalCase[],artifactVerified:boolean){
  const policy={minimumDimensionScore:3,requiredToolEvidence:true};
  if(!report||!artifactVerified||!report.cases.length)return {status:'NOT_VALIDATED' as const,reasons:['运行或候选资产证据不完整'],policy};
  const reasons:string[]=[];
  let indeterminate=0;
  if(new Set(report.cases.map(item=>item.caseId)).size!==report.cases.length)reasons.push('评测报告存在重复案例');
  for(const definition of cases)if(!report.cases.some(item=>item.caseId===definition.caseId))reasons.push(`${definition.caseId}: 冻结案例未完成`);
  for(const result of report.cases){
    const definition=cases.find(item=>item.caseId===result.caseId);
    if(!definition){reasons.push(`${result.caseId}: 缺少冻结案例定义`);continue;}
    const expected=definition.toolExpectations??{mustSucceed:definition.requiredTools,mustNotCall:[]};
    const evidence=result.right;
    if(!evidence.streamCompleted||!evidence.runtimeIdentityVerified)reasons.push(`${result.caseId}: Runtime 执行证据未完成`);
    const facts=Array.isArray(evidence.metadata.toolEvidence)?evidence.metadata.toolEvidence as Array<{tool?:string;resultDigest?:string}>:[];
    for(const name of expected.mustSucceed){
      if(!evidence.toolCalls.some(call=>call.name===name&&call.status==='completed')||!facts.some(fact=>fact.tool===name&&!!fact.resultDigest))reasons.push(`${result.caseId}: ${name} 缺少成功调用证据`);
    }
    for(const name of expected.mustNotCall)if(evidence.toolCalls.some(call=>call.name===name))reasons.push(`${result.caseId}: 不应调用 ${name}`);
    for(const criterion of definition.rubric.filter(item=>item.required)){
      const match=(pattern:string)=>{try{return new RegExp(pattern,'iu').test(evidence.output);}catch{return false;}};
      if(criterion.allOf.some(pattern=>!match(pattern))||(criterion.anyOf.length&&!criterion.anyOf.some(match))||criterion.noneOf.some(match))reasons.push(`${result.caseId}: 必备规则未满足 ${criterion.criterionId}`);
    }
    if(!result.judge||result.judgeError)reasons.push(`${result.caseId}: 质量评估缺失`);
    else {
      const assessment=result.judge.serviceComparison??result.judge.goalAssessment;
      if(assessment){
        if(result.judge.serviceComparison&&result.left.status!=='completed')reasons.push(`${result.caseId}: 原服务基线未执行完成`);
        if(assessment.verdict==='INDETERMINATE')indeterminate++;
        if(assessment.verdict!=='PASS')reasons.push(`${result.caseId}: ${assessment.verdict==='FAIL'?'未满足验收要求':'无法判定'}：${assessment.reason}`);
        continue;
      }
      if(['professional_fit','business_completeness','clarity','actionability'].some(id=>!result.judge!.dimensions.some(item=>item.id===id)))reasons.push(`${result.caseId}: 质量维度不完整`);
      for(const dimension of result.judge.dimensions)if(!Number.isFinite(dimension.rightScore)||dimension.rightScore<policy.minimumDimensionScore)reasons.push(`${result.caseId}: ${dimension.label} ${dimension.rightScore}/4，低于 ${policy.minimumDimensionScore}/4`);
    }
  }
  return {status:reasons.length?(reasons.length===indeterminate?'NOT_VALIDATED' as const:'FAILED' as const):'PASSED' as const,reasons,policy};
}
