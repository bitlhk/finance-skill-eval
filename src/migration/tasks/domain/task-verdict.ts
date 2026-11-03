/** Missing test coverage is not evidence that the candidate needs code changes. */
export function hasCandidateFailures(run: {cases:Array<{passed:boolean;unverified?:boolean;criteria?:Array<{passed:boolean|null}>}>;requirementCoverage?:Array<{status:'PASSED'|'FAILED'|'UNVERIFIED'}>}): boolean {
  return run.cases.some(c=>c.criteria?.some(criterion=>criterion.passed===false)||(!c.passed&&!c.unverified))||Boolean(run.requirementCoverage?.some(r=>r.status==='FAILED'));
}
