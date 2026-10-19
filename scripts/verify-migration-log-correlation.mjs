import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Read-only audit of a local real-model test; output contains IDs/counts only.
const [reportDirectory, apiLog] = process.argv.slice(2);
assert(reportDirectory && apiLog, 'Usage: node scripts/verify-migration-log-correlation.mjs REPORT_DIRECTORY API_LOG');
const jsonLines = text => text.split(/\r?\n/).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const task = JSON.parse(await readFile(path.join(reportDirectory, 'task.json'), 'utf8'));
const result = JSON.parse(await readFile(path.join(reportDirectory, 'result.json'), 'utf8'));
assert.equal(result.status, 'PASSED', 'Audit completed acceptance runs only');
const api = jsonLines(await readFile(apiLog, 'utf8'));
const runtime = jsonLines(await readFile(path.join(reportDirectory, 'runtime.log'), 'utf8'));
let agents = 0, cases = 0;
for (const attempt of task.attempts) {
  assert(attempt.requestId, 'Attempt lacks request correlation');
  assert(api.some(row => row.reqId === attempt.requestId && row.req?.method === 'POST'), 'HTTP request not linked');
  for (const event of ['bundle_operation_started', 'bundle_operation_finished']) {
    assert(api.some(row => row.event === event && row.taskId === task.id && row.attemptId === attempt.id && row.requestId === attempt.requestId), event + ' not linked');
  }
  if (attempt.kind !== 'ACCEPT') {
    assert(attempt.agentRunId, 'Missing Agent identity');
    for (const event of ['agent_process_started', 'agent_process_exited']) {
      assert(api.some(row => row.event === event && row.taskId === task.id && row.attemptId === attempt.id && row.runId === attempt.agentRunId && row.requestId === attempt.requestId), event + ' not linked');
    }
    agents++;
    continue;
  }
  const run = task.runs.find(run => run.id === attempt.runId);
  assert(run, 'Attempt not linked to acceptance run');
  for (const item of run.cases) {
    assert(api.some(row => row.event === 'bundle_case_started' && row.attemptId === attempt.id && row.runId === run.id && row.caseId === item.id), 'Case not linked');
    for (const event of ['runtime_session_started', 'runtime_session_finished']) {
      assert(runtime.some(row => row.event === event && row.runId === run.id && row.caseId === item.id), event + ' not linked');
    }
    const judge = api.find(row => row.event === 'migration_judge_started' && row.attemptId === attempt.id && row.runId === run.id && row.caseId === item.id);
    if (item.passed) assert(judge?.judgeRequestId, 'Judge not linked');
    if (judge) {
      assert(api.some(row => row.event === 'migration_judge_finished' && row.judgeRequestId === judge.judgeRequestId && (item.passed ? row.status === 'COMPLETED' : ['COMPLETED', 'FAILED'].includes(row.status))), 'Judge completion not linked');
    }
    cases++;
  }
}
const audit = { status: 'PASSED', taskId: task.id, memberCount: task.source.members.length, attempts: task.attempts.length, agents, cases, chain: ['HTTP', 'task', 'attempt', 'agentProcess', 'runtimeCase', 'judgeRequest'] };
await writeFile(path.join(reportDirectory, 'correlation-audit.json'), JSON.stringify(audit, null, 2));
console.log(JSON.stringify(audit));
