import type {CriterionVerdict} from './criterion-judge-port.js';
import type {EvaluationMethodResult} from './evaluation-method.js';
import type {EvaluationReport} from '../../report.js';
import type {ReviewTarget} from '../domain/human-review.js';
const outcomes=['PASS','FAIL','UNVERIFIED'] as const;
const verdict=(value:string|undefined)=>value==='PASS'||value==='FAIL'?value:null;
export function migrationReviewTargets(run:{cases:Array<CriterionVerdict&{id:string;failureStage?:string;methodResults?:EvaluationMethodResult[]}>}):ReviewTarget[]{
  return run.cases.flatMap((c,index)=>{
    const root=`/cases/${index}`;
    const targets:ReviewTarget[]=[{id:root,caseId:c.id,label:'案例结论',scope:'case',machine:c.failureStage||c.unverified?null:c.passed?'PASS':'FAIL',outcomes:[...outcomes],evidenceRoot:root}];
    c.criteria?.forEach((criterion,i)=>targets.push({id:`${root}/criteria/${i}`,caseId:c.id,label:criterion.id,scope:'criterion',
      machine:criterion.passed===null?null:criterion.passed?'PASS':'FAIL',outcomes:[...outcomes],evidenceRoot:root}));
    c.methodResults?.forEach((method,i)=>targets.push({id:`${root}/methodResults/${i}`,caseId:c.id,label:method.methodId,scope:'method',
      machine:verdict(method.status),outcomes:[...outcomes],evidenceRoot:root}));
    return targets;
  });
}
export function comparisonReviewTargets(report:EvaluationReport):ReviewTarget[]{
  return report.cases.flatMap((c,index)=>{
    const root=`/cases/${index}`,targets:ReviewTarget[]=[];
    const add=(id:string,label:string,machine:string|null,scope:ReviewTarget['scope']='case',choices:ReviewTarget['outcomes']=[...outcomes])=>
      targets.push({id:root+id,caseId:c.caseId,label,machine,scope,outcomes:choices,evidenceRoot:root});
    const judge=c.judge;
    if(judge?.runtimeComparison){
      for(const side of ['left','right'] as const){const result=judge.runtimeComparison[side];add(`/judge/runtimeComparison/${side}`,side, result.status==='assessed'?verdict(result.assessment.verdict):null);}
    }else if(judge?.goalAssessment||judge?.serviceComparison){
      const key=judge.goalAssessment?'goalAssessment':'serviceComparison',assessment=judge.goalAssessment??judge.serviceComparison!;
      add(`/judge/${key}`,'业务结论',verdict(assessment.verdict));
      assessment.checks.forEach((check,i)=>add(`/judge/${key}/checks/${i}`,check.criterion,verdict(check.verdict),'criterion'));
    }else if(judge?.winner)add('/judge/winner','两侧回答偏好（不等于业务达标）',judge.winner,'pairwise',['left','right','tie','UNVERIFIED']);
    for(const side of ['left','right'] as const)c.methodResults?.[side]?.forEach((method,i)=>add(`/methodResults/${side}/${i}`,`${side} · ${method.methodId}`,verdict(method.status),'method'));
    return targets;
  });
}
