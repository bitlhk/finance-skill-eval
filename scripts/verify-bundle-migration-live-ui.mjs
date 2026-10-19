import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { zipSync, unzipSync } from 'fflate';

// No injected ports, response replay, request interception or fixture model endpoints.
// The only authored input is a business example and its independently held test data.
if (process.env.BUNDLE_LIVE_ENV_FILE) process.loadEnvFile(process.env.BUNDLE_LIVE_ENV_FILE);
const root = process.cwd(),
  startedAt = new Date().toISOString();
const directory = path.resolve('reports', 'bundle-live-' + randomUUID());
await mkdir(directory, { recursive: true });
process.env.FINANCE_EVAL_AGENT_DUMP = path.join(directory, 'agent-diagnostics');
const data = path.join(directory, 'data'),
  token = randomUUID();
const python = process.env.FINANCE_EVAL_MIGRATION_PYTHON;
assert(python, 'Set FINANCE_EVAL_MIGRATION_PYTHON to the real OpenJiuwen interpreter');
assert(process.env.FINANCE_RUNTIME_CONFIG, 'Set FINANCE_RUNTIME_CONFIG to a private model configuration');
process.env.FINANCE_EVAL_MIGRATION_PROJECT_ROOT = root;
process.env.FINANCE_EVAL_MIGRATION_AGENT = 'on';
const runtimeConfig = JSON.parse(await readFile(process.env.FINANCE_RUNTIME_CONFIG, 'utf8'));
const modelId = process.env.FINANCE_EVAL_AGENT_MODEL_ID ?? runtimeConfig.defaultModelId;
assert(runtimeConfig.models[modelId]?.apiKey, 'Runtime requires a configured real model credential');
process.env.FINANCE_EVAL_AGENT_MODEL_ID = modelId;
const { createEvaluationService } = await import('../dist/service/server.js');
const { configuredModelRole } = await import('../dist/service/config.js');
const judge = configuredModelRole('JUDGE');
assert(judge.configured && judge.adapter, 'Configure a real Judge before starting this test');
const checks = [],
  errors = [];
let app, browser, page, worker, workerLog, taskId, serviceUrl, lastTask;
const report = {
  mode: 'REAL_AGENT_RUNTIME_AND_JUDGE',
  startedAt,
  status: 'RUNNING',
  checks,
  models: {
    migration: runtimeConfig.models[modelId].upstreamModelId ?? modelId,
    execution: runtimeConfig.models[modelId].upstreamModelId ?? modelId,
    judge: judge.model.modelId,
  },
};
const save = () => writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
const pass = (name) => {
  checks.push(name);
  console.log('PASS ' + name);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function api(suffix) {
  const response = await fetch(serviceUrl + suffix, { headers: { authorization: 'Bearer ' + token } });
  assert(response.ok, 'Read API failed ' + response.status);
  return response.json();
}
async function refresh() {
  lastTask = await api('/api/migration-bundles/' + taskId);
  await writeFile(path.join(directory, 'task.json'), JSON.stringify(lastTask, null, 2));
  return lastTask;
}
async function waitAttempt(kind, previousCount) {
  const deadline = Date.now() + 20 * 60 * 1000;
  let lastMessage = '',
    logged = 0;
  while (Date.now() < deadline) {
    const task = await refresh(),
      attempt = task.attempts.at(-1);
    if (attempt && task.attempts.length > previousCount && attempt.kind === kind) {
      if (attempt.message !== lastMessage || Date.now() - logged > 30000) {
        console.log(kind + ': ' + attempt.status + ' ' + attempt.message);
        lastMessage = attempt.message;
        logged = Date.now();
      }
      if (attempt.status !== 'RUNNING') {
        assert.equal(attempt.status, 'COMPLETED', attempt.error ?? attempt.message);
        return task;
      }
    }
    await pause(1500);
  }
  throw new Error(kind + ' exceeded the real-model test deadline');
}
async function act(name, kind) {
  const before = (await refresh()).attempts.length;
  await page.getByRole('button', { name, exact: true }).click();
  const task = await waitAttempt(kind, before);
  // The page polls independently; wait for its visible operation control to settle.
  await expect(page.getByRole('button', { name: '取消当前操作', exact: true })).toHaveCount(0, {
    timeout: 10000,
  });
  return task;
}
const stage = (name) =>
  page
    .getByRole('navigation', { name: '整组迁移步骤' })
    .getByRole('button', { name: new RegExp(name) })
    .click();
const dataFile = (values) => [{ path: 'fixtures/budgets.json', content: JSON.stringify(values) }];
const query = (center, amount) =>
  '请实际使用 budget-query、purchase-review 和 audit-report 三个 Skill，读取本案例工作区 fixtures/budgets.json，并执行迁移后的预算查询与审核脚本。审核成本中心 ' +
  center +
  ' 的 ' +
  amount +
  ' 元采购，提供金额、结论及真实执行证据；不要仅靠心算替代脚本。必须使用冻结候选中的原始脚本，不得临时修改或复制后修补；如脚本存在缺陷，报告真实错误供迁移 Agent 修复。';
const suite = {
  name: '真实多 Skill 采购联合验收',
  cases: [
    {
      id: 'over-budget',
      input: query('CC-RED', '8123.45'),
      workspaceFiles: dataFile({ 'CC-RED': { available_cents: 531275, currency: 'CNY' } }),
      criteria: [
        '可用预算为 5312.75 元，申请 8123.45 元，决定 REJECT，差额 2810.70 元。',
        '运行证据包含实际预算查询和审核脚本调用，使用真实案例数据而非编造；报告指出未执行审批、预留或扣款。',
      ],
    },
    {
      id: 'equal-budget',
      input: query('CC-EQUAL', '947.23'),
      workspaceFiles: dataFile({ 'CC-EQUAL': { available_cents: 94723, currency: 'CNY' } }),
      criteria: [
        '预算与申请均为 947.23 元，决定 ALLOW，差额 0.00 元；没有因等于预算而拒绝。',
        '实际执行预算查询与审核，明确 ALLOW 只是评估结果，不表示审批或扣款已发生。',
      ],
    },
  ],
  holdoutCases: [
    {
      id: 'unknown-center',
      input: query('CC-MISSING', '123.45'),
      workspaceFiles: dataFile({ 'CC-OTHER': { available_cents: 999999, currency: 'CNY' } }),
      criteria: [
        '对 CC-MISSING 返回 UNAVAILABLE 或等价无法判断，不得使用 CC-OTHER 的预算批准申请，也不得将未知预算当成零预算。',
        '实际执行查询与审核，报告明确缺少该成本中心预算且未发生审批、预留或扣款。',
      ],
    },
  ],
};
try {
  await save();
  console.log('REPORT ' + directory);
  const port = await availablePort(),
    runtimeUrl = 'http://127.0.0.1:' + port + '/';
  workerLog = createWriteStream(path.join(directory, 'runtime.log'));
  worker = spawn(
    python,
    ['-m', 'uvicorn', 'integrations.openjiuwen.worker:app', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
    },
  );
  worker.stdout.pipe(workerLog);
  worker.stderr.pipe(workerLog);
  let capabilities;
  for (let i = 0; i < 60; i++) {
    assert(worker.exitCode === null, 'Real Runtime process exited during startup');
    try {
      const response = await fetch(runtimeUrl + 'v1/runtime-capabilities');
      if (response.ok) {
        capabilities = await response.json();
        break;
      }
    } catch {}
    await pause(1000);
  }
  assert(capabilities?.features.multiSkill, 'Real Runtime must advertise multiSkill');
  report.capabilities = capabilities;
  pass('real_openjiuwen_runtime_started');
  app = await createEvaluationService({
    rootDirectory: root,
    dataDirectory: data,
    publicDirectory: path.join(root, 'web-dist'),
    accessToken: token,
    publicDemo: false,
    workspaceMode: 'single',
    managedWorkspace: false,
  });
  app.log.level = 'error';
  const registered = await app.inject({
    method: 'POST',
    url: '/api/environments',
    headers: { authorization: 'Bearer ' + token },
    payload: {
      name: '真实 OpenJiuwen 多 Skill Runtime',
      type: 'runtime_launcher',
      runtimeType: 'openjiuwen',
      baseUrl: runtimeUrl,
    },
  });
  assert.equal(registered.statusCode, 200, registered.body);
  serviceUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(serviceUrl);
  await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button', { name: '进入工作区', exact: true }).click();
  await page.getByRole('button', { name: 'Skill 迁移', exact: true }).click();
  await page.getByRole('button', { name: '多 Skill 整体迁移', exact: true }).click();
  await page.getByLabel('任务名称', { exact: true }).fill('真实采购多 Skill 迁移');
  await page
    .getByLabel('目标环境与要求', { exact: true })
    .fill(
      '迁移到 OpenJiuwen 原生多 Skill + Python 标准库 CLI。取消 LegacyContext 注入依赖，预算查询与审核两个工具之间统一传递 available_yuan 十进制字符串，原始 JSON 文件仍存 available_cents。保留业务规则、未知中心和金额校验。支持从当前业务 cwd 读取 fixtures/budgets.json。三个 Skill 的路径和名称保持不变。',
    );
  await page
    .getByLabel('业务目标', { exact: true })
    .fill(
      '三个 Skill 协作完成采购预算查询、规则判断和审计报告。真实读取工作区数据，实际执行预算查询和审核 CLI，不能用模型心算取代工具。共同适配共享代码和 Skill 调用说明，纯标准库实现，无需 MCP 或网络业务服务。',
    );
  const source = path.join(root, 'acceptance', 'multi-skill-procurement'),
    files = {};
  for (const name of await readdir(source, { recursive: true })) {
    if (name.includes('__pycache__') || name.endsWith('.pyc')) continue;
    const content = await readFile(path.join(source, name)).catch((error) =>
      ['EISDIR', 'EPERM'].includes(error.code) ? null : Promise.reject(error),
    );
    if (content) files[name.replaceAll('\\', '/')] = content;
  }
  const archive = Buffer.from(zipSync(files));
  await writeFile(path.join(directory, 'source.zip'), archive);
  await page
    .locator('.bundle-panel input[type=file]')
    .first()
    .setInputFiles({ name: 'procurement.zip', mimeType: 'application/zip', buffer: archive });
  await expect(page.getByRole('heading', { name: '真实采购多 Skill 迁移', exact: true })).toBeVisible();
  const tasks = await api('/api/migration-bundles');
  assert.equal(tasks.length, 1);
  taskId = tasks[0].id;
  report.taskId = taskId;
  pass('whole_workspace_imported_through_ui');
  let task = await act('分析整组 Skill', 'ANALYZE');
  assert.deepEqual(task.analysis.missing, [], JSON.stringify(task.analysis));
  await page.screenshot({ path: path.join(directory, 'analysis.png'), fullPage: true });
  pass('real_agent_analyzed_whole_workspace');
  await stage('生成迁移结果');
  task = await act('生成整组迁移结果', 'GENERATE');
  assert(task.currentCandidateId);
  assert(task.candidates.at(-1).diff.length > 0, 'Migration produced no actual changes');
  await page.screenshot({ path: path.join(directory, 'candidate.png'), fullPage: true });
  pass('real_agent_generated_frozen_candidate');
  await stage('Runtime 适配与登记');
  await page
    .getByLabel('已登记执行环境', { exact: true })
    .selectOption({ label: '真实 OpenJiuwen 多 Skill Runtime' });
  await page.getByLabel('执行模型', { exact: true }).selectOption(modelId);
  await page.getByLabel('每个案例超时（秒）', { exact: true }).fill('600');
  await page.getByLabel('允许执行 Skill 包中的脚本（目标环境需支持）', { exact: true }).check();
  await page.getByRole('button', { name: '保存运行配置', exact: true }).click();
  await page.getByRole('button', { name: '检查运行能力', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('检查通过');
  await stage('联合验收');
  await page.getByLabel('验收测试集 JSON', { exact: true }).fill(JSON.stringify(suite, null, 2));
  await page.getByRole('button', { name: '保存测试集', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  for (let repair = 0; repair <= 2; repair++) {
    task = await act('开始整组联合验收', 'ACCEPT');
    await page.screenshot({ path: path.join(directory, 'development-' + repair + '.png'), fullPage: true });
    if (task.runs.at(-1).status === 'PASSED') break;
    assert(repair < 2, 'Real development acceptance failed after two actual Agent repairs');
    console.log('Real development acceptance failed; requesting actual whole-workspace repair');
    await act('让 Agent 查看整组并修复', 'REPAIR');
    await stage('联合验收');
  }
  assert.equal(task.runs.at(-1).status, 'PASSED');
  pass('real_runtime_and_judge_development_passed');
  task = await act('执行独立留出验收', 'ACCEPT');
  assert.equal(
    task.runs.at(-1).status,
    'PASSED',
    'Real holdout acceptance failed; held-out feedback is not sent to repair',
  );
  pass('real_runtime_and_judge_holdout_passed');
  for (const run of task.runs.filter(
    (r) => r.candidateId === task.currentCandidateId && r.status === 'PASSED',
  )) {
    for (const item of run.cases) {
      assert(item.evidence.runtimeIdentityVerified && item.evidence.streamCompleted);
      assert.equal(item.evidence.metadata.bundleDigest, run.candidateDigest);
      assert.equal(item.evidence.loadedSkills.length, 3);
      // The production launcher annotates the transport mode; Worker identity
      // is checked separately against the capabilities of our actual process.
      assert.equal(item.evidence.metadata.executionMode, 'runtime-launcher');
      assert.equal(item.evidence.metadata.runtimeVersion, capabilities.runtime.version);
      assert.equal(item.evidence.metadata.agentType, 'DeepAgent');
      assert.equal(item.evidence.metadata.modelBinding.upstreamModelId, report.models.execution);
      for (const name of ['budget-query', 'purchase-review', 'audit-report']) {
        assert(
          item.evidence.metadata.referenceFilesRead['skills/' + name + '/SKILL.md'],
          'No actual activation evidence for ' + name,
        );
      }
      assert(
        item.evidence.toolCalls.some((call) => call.name === 'bash' && call.status === 'completed'),
        'Actual script execution is required',
      );
      assert(
        item.evidence.toolCalls.some((call) => call.name === 'skill_tool' && call.status === 'completed'),
        'Actual framework Skill activation is required',
      );
    }
  }
  pass('verified_runtime_identity_all_members_and_actual_script_calls');
  await page.screenshot({ path: path.join(directory, 'joint-passed.png'), fullPage: true });
  await stage('下载结果');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载已验收交付包', exact: true }).click();
  const download = await pending;
  await download.saveAs(path.join(directory, 'verified-bundle.zip'));
  const exported = unzipSync(await readFile(path.join(directory, 'verified-bundle.zip')));
  const manifest = JSON.parse(Buffer.from(exported['migration/manifest.json']).toString());
  assert.equal(manifest.verified, true);
  assert.equal(manifest.candidate.id, task.currentCandidateId);
  for (const name of ['budget-query', 'purchase-review', 'audit-report'])
    assert(exported['package/skills/' + name + '/SKILL.md']);
  pass('verified_full_bundle_downloaded_through_ui');
  assert.deepEqual(errors, []);
  const health = await (await fetch(runtimeUrl + 'health')).json();
  assert.equal(health.activeSessions, 0);
  pass('runtime_sessions_released');
  report.status = 'PASSED';
  report.candidateId = task.currentCandidateId;
  report.runs = task.runs.map((r) => ({
    id: r.id,
    candidateId: r.candidateId,
    phase: r.phase,
    status: r.status,
    cases: r.cases.map((c) => ({ id: c.id, passed: c.passed, reason: c.reason })),
  }));
} catch (error) {
  report.status = 'FAILED';
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  if (page)
    await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  if (taskId) await refresh().catch(() => {});
  console.error('FAILED ' + report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  await save();
  await browser?.close();
  await app?.close();
  if (worker && worker.exitCode === null) {
    worker.kill();
    await Promise.race([new Promise((resolve) => worker.once('exit', resolve)), pause(5000)]);
  }
  workerLog?.end();
  console.log(
    JSON.stringify({
      status: report.status,
      mode: report.mode,
      report: path.join(directory, 'result.json'),
      checks,
    }),
  );
}
