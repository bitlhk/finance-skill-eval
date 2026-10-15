import type {EvaluationJob} from './types';

type Case = NonNullable<EvaluationJob['report']>['cases'][number];
const labels = {PASS: '通过', FAIL: '未通过', INDETERMINATE: '无法判断'};

export function RuntimeGoalResults({item}: {item: Case}) {
  return <div className="answer-grid runtime-goal-results">{(['left', 'right'] as const).map(side => {
    const result = item[side].status==='completed'?item.judge?.runtimeComparison?.[side]:undefined;
    return <article key={side}>
      <strong>{side === 'left' ? 'A' : 'B'} · {result?.status === 'assessed' ? labels[result.assessment.verdict] : '未形成评估'}</strong>
      {!result ? <p>{item[side].error ?? item.judgeError ?? '没有独立评估结果。'}</p>
        : result.status === 'unavailable' ? <p>{result.error}</p>
        : result.assessment.checks.map((check, index) => <details key={index}>
          <summary>{labels[check.verdict]} · {check.criterion}</summary>
          <p>{check.reason}</p>{check.evidence && <blockquote>{check.evidence}</blockquote>}
        </details>)}
    </article>;
  })}</div>;
}

export function runtimeGoalCounts(cases: Case[], side: 'left' | 'right') {
  return cases.reduce((counts, item) => {
    const result = item[side].status==='completed'?item.judge?.runtimeComparison?.[side]:undefined;
    counts[result?.status === 'assessed' ? result.assessment.verdict : 'unavailable']++;
    return counts;
  }, {PASS: 0, FAIL: 0, INDETERMINATE: 0, unavailable: 0});
}
