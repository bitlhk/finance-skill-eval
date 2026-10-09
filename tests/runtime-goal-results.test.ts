import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {RuntimeGoalResults, runtimeGoalCounts} from '../web/src/RuntimeGoalResults';
import type {EvaluationJob} from '../web/src/types';

type Case = NonNullable<EvaluationJob['report']>['cases'][number];
const item = (verdict: 'PASS' | 'FAIL' | 'INDETERMINATE'): Case => ({judge: {
  runtimeComparison: {left: {status: 'assessed', assessment: {verdict, reason: 'Observed result', checks: [
    {criterion: 'Original requirement', verdict, reason: 'Insufficient facts', evidence: ''}]}},
    right: {status: 'unavailable', error: 'Runtime failed'}}, dimensions: [], summary: '', confidence: 'medium'},
} as Case);

it('does not label an indeterminate or unavailable side as a tie or a pass', () => {
  const cases = [item('PASS'), item('FAIL'), item('INDETERMINATE')];
  expect(runtimeGoalCounts(cases, 'left')).toEqual({PASS: 1, FAIL: 1, INDETERMINATE: 1, unavailable: 0});
  expect(runtimeGoalCounts(cases, 'right')).toEqual({PASS: 0, FAIL: 0, INDETERMINATE: 0, unavailable: 3});
  const html = renderToStaticMarkup(createElement(RuntimeGoalResults, {item: cases[2]!}));
  expect(html).toContain('无法判断');
  expect(html).toContain('Runtime failed');
  expect(html).toContain('Original requirement');
  expect(html).not.toContain('持平');
  expect(html).not.toContain('更优');
});
