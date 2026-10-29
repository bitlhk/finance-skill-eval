import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Read-only audit of a local real-model test; output contains IDs/counts only.
const [reportDirectory, ...apiLogs] = process.argv.slice(2);
assert(reportDirectory && apiLogs.length, 'Usage: node scripts/verify-migration-log-correlation.mjs REPORT_DIRECTORY API_LOG [EARLIER_API_LOG ...]');
const jsonLines = text => text.split(/\r?\n/).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const task = JSON.parse(await readFile(path.join(reportDirectory, 'task.json'), 'utf8'));
const result = JSON.parse(await readFile(path.join(reportDirectory, 'result.json'), 'utf8'));
assert.equal(result.status, 'PASSED', 'Audit completed acceptance runs only');
const api = (await Promise.all(apiLogs.map(file => readFile(file, 'utf8')))).flatMap(jsonLines);
const builderMode = result.mode === 'REAL_BUILDER_AGENT_RUNTIME_AND_JUDGE';
const runtime = builderMode ? [] : jsonLines(await readFile(path.join(reportDirectory, 'runtime.log'), 'utf8'));
let agents = 0, cases = 0, interruptedAttempts = 0;
for (const attempt of task.attempts) {
  assert(attempt.requestId, 'Attempt lacks request correlation');
  assert(api.some(row => row.reqId === attempt.requestId && row.req?.method === 'POST'), 'HTTP request not linked');
  if(attempt.status==='INTERRUPTED')interruptedAttempts++;
  for (const event of attempt.status==='INTERRUPTED'?['bundle_operation_started']:['bundle_operation_started', 'bundle_operation_finished']) {
    assert(api.some(row => row.event === event && row.taskId === task.id && row.attemptId === attempt.id && row.requestId === attempt.requestId), event + ' not linked');
  }
  if (attempt.kind !== 'ACCEPT') {
    assert(attempt.agentRunId, 'Missing Agent identity');
    for (const event of attempt.status==='INTERRUPTED'?['agent_process_started']:['agent_process_started', 'agent_process_exited']) {
      assert(api.some(row => row.event === event && row.taskId === task.id && row.attemptId === attempt.id && row.runId === attempt.agentRunId && row.requestId === attempt.requestId), event + ' not linked');
    }
    agents++;
    continue;
  }
  const run = task.runs.find(run => run.id === attempt.runId);
  assert(run, 'Attempt not linked to acceptance run');
  for (const item of run.cases) {
    assert(api.some(row => row.event === 'bundle_case_started' && row.attemptId === attempt.id && row.runId === run.id && row.caseId === item.id), 'Case not linked');
    if (builderMode && item.evidence) {
      // External Launcher JSON transport correlates its actual execution evidence
      // and managed cleanup receipts; it does not produce the built-in worker log.
      const evidence = item.evidence;
      assert.equal(evidence.runId, run.id);
      assert.equal(evidence.caseId, item.id);
      assert(evidence.metadata.instanceConfigurationDigest);
      assert(run.finalization.some(receipt => receipt.instanceId === evidence.metadata.instanceId && receipt.status === 'RELEASED'), 'Runtime instance cleanup not linked');
    } else if(!builderMode) for (const event of ['runtime_session_started', 'runtime_session_finished']) {
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
for (const binding of builderMode ? task.runtimeDeliveries : []) {
  assert(api.some(row => row.event === 'migration_builder_delivery_bound' && row.taskId === task.id
    && row.bindingId === binding.id && row.buildId === binding.result.buildId
    && row.resultDigest === binding.result.resultDigest && row.deploymentId === binding.launcher.deploymentId
    && row.conformanceRunId === binding.launcher.evalConformance.runId), 'Builder binding not linked');
}
const audit = { status: 'PASSED', taskId: task.id, memberCount: task.source.members.length, attempts: task.attempts.length, interruptedAttempts, agents, cases,
  ...(builderMode ? {builderBindings:task.runtimeDeliveries.length, runtimeCorrelation:'NATIVE_EVIDENCE_AND_CLEANUP_RECEIPTS'} : {}),
  chain: ['HTTP', 'task', 'attempt', 'agentProcess', ...(builderMode ? ['builderBuild','binding','deployment'] : []), 'runtimeCase', 'judgeRequest'] };
await writeFile(path.join(reportDirectory, 'correlation-audit.json'), JSON.stringify(audit, null, 2));
console.log(JSON.stringify(audit));
