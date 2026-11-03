import type {EvaluationReport} from '../../report.js';
import {checkExecutionEvidence} from '../domain/execution-checks.js';

/** A business failure can be repeated; uncertain execution or assessment cannot. */
export function comparisonExecutionIncomplete(report:EvaluationReport){
  return !report.cases.length||report.cases.some(c=>!c.judge||Boolean(c.judgeError)
    ||[c.left,c.right].some(e=>checkExecutionEvidence(e).some(check=>check.status!=='PASS'))
    ||Object.values(c.methodResults??{}).flat().some(m=>!['PASS','FAIL'].includes(m.status))
    ||[c.judge?.goalAssessment?.verdict,c.judge?.serviceComparison?.verdict].includes('INDETERMINATE')
    ||(c.judge?.runtimeComparison&&Object.values(c.judge.runtimeComparison).some(r=>r.status!=='assessed'||r.assessment.verdict==='INDETERMINATE')));
}
