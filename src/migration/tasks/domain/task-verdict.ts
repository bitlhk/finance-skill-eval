/** Missing test coverage is not evidence that the candidate needs code changes. */
export function hasCandidateFailures(run: {cases:Array<{passed:boolean}>;requirementCoverage?:Array<{status:'PASSED'|'FAILED'|'UNVERIFIED'}>}): boolean {
  return run.cases.some(c=>!c.passed)||Boolean(run.requirementCoverage?.some(r=>r.status==='FAILED'));
}
