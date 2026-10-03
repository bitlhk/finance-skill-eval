import assert from 'node:assert/strict';
import test from 'node:test';
import {controlledGoalJudge} from './controlled-goal-judge.mjs';

test('controlled Judge rejects pairwise requests and never claims quality success', async () => {
  const previous = process.env.FINANCE_EVAL_JUDGE_BASE_URL;
  const judge = await controlledGoalJudge();
  try {
    const send = value => fetch(process.env.FINANCE_EVAL_JUDGE_BASE_URL + '/chat/completions', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({messages: [{role: 'user', content: JSON.stringify(value)}]}),
    });
    assert.equal((await send({left: 'answer', right: 'answer'})).status, 500);
    assert.equal(judge.calls.length, 0);
    const response = await send({criteria: [{criterionIndex: 0, description: 'Check a fact'}]});
    assert.equal(response.status, 200);
    const value = JSON.parse((await response.json()).choices[0].message.content);
    assert.equal(value.checks[0].verdict, 'INDETERMINATE');
    assert.equal(judge.calls.length, 1);
  } finally {await judge.close();}
  assert.equal(process.env.FINANCE_EVAL_JUDGE_BASE_URL, previous);
});
