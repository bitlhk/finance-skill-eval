/** Original curated cases through the real UI and two native Launchers. Controlled, not quality acceptance. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdir, readFile, writeFile, cp} from 'node:fs/promises';
import path from 'node:path';
import {parse as parseYaml} from 'yaml';
import {chromium, expect} from '@playwright/test';
import {createEvaluationService} from '../dist/service/server.js';
import {SkillStore} from '../dist/service/skill-store.js';
import {loadEvalPack} from '../dist/eval-pack.js';

const output = path.resolve(process.env.CURATED_UI_OUTPUT);
await mkdir(output, {mode: 0o700});
const flow = process.env.CURATED_UI_FLOW ?? 'prebuilt';
assert(['prebuilt', 'upload'].includes(flow));
const paths = JSON.parse(await readFile(process.env.CURATED_UI_FIXTURES, 'utf8'));
const fixtures = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, file]) =>
  [key, JSON.parse(await readFile(file, 'utf8'))])));
assert.deepEqual(Object.keys(fixtures).sort(), ['agentscope', 'openjiuwen']);
const skill = JSON.parse(await readFile(path.join(process.env.CURATED_UI_SKILL_PROBE, 'skill.json'), 'utf8'));
const archive = Buffer.from(skill.archiveBase64, 'base64');
const root = path.join(output, 'root'), data = path.join(output, 'data');
await mkdir(path.join(root, 'packs/finance'), {recursive: true});
await cp(path.join(process.env.CURATED_UI_STAGING, 'packs/candidate'), path.join(root, 'packs/finance/candidate'), {recursive: true});
await cp('packs/finance/catalog.yaml', path.join(root, 'packs/finance/catalog.yaml'));
const pack = await loadEvalPack(path.join(root, 'packs/finance/candidate/eval.yaml'));
assert.equal(pack.targetSkillId, skill.skillId);
assert.equal(pack.targetSkillVersion, skill.version);
const catalog = parseYaml(await readFile('packs/finance/catalog.yaml', 'utf8'));
const displayName = catalog.skills.find(row => row.skillId === skill.skillId)?.displayName;
assert(displayName, 'Use an actual curated catalog entry');
const token = randomBytes(32).toString('hex');
const generation = {temperature: 0, top_p: 1, max_tokens: 1024};
const modelFile = path.join(output, 'models.json');
await writeFile(modelFile, JSON.stringify({schemaVersion: 'finance.skill-eval.execution-models.v1', defaultModelId: 'launcher-model',
  models: [{providerId: 'managed-launcher', modelId: 'launcher-model', label: 'Controlled native model', availability: 'ready', parameters: generation}]}));
process.env.FINANCE_EVAL_EXECUTION_CATALOG = modelFile;
const judgeCalls = [];
const judge = http.createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    const input = JSON.parse(request.messages.find(message => message.role === 'user').content);
    assert(Array.isArray(input.criteria) && input.criteria.length > 0);
    judgeCalls.push(input);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({model: 'controlled-judge', choices: [{message: {role: 'assistant', content: JSON.stringify({
      checks: input.criteria.map(row => ({criterionIndex: row.criterionIndex, verdict: 'INDETERMINATE',
        reason: 'Controlled transport fixture; professional quality not evaluated.', evidence: ''}))})}}]}));
  } catch (error) {res.writeHead(500); res.end(JSON.stringify({error: String(error)}));}
});
await new Promise(resolve => judge.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, {FINANCE_EVAL_JUDGE_PROVIDER: 'openai_compatible',
  FINANCE_EVAL_JUDGE_BASE_URL: `http://127.0.0.1:${judge.address().port}/v1`,
  FINANCE_EVAL_JUDGE_API_KEY: 'controlled-test-only', FINANCE_EVAL_JUDGE_MODEL: 'controlled-judge', FINANCE_EVAL_JUDGE_REQUEST_DEFAULTS: '{}'});
let app, browser, page, asset;
const errors = [], checks = [];
try {
  if (flow === 'prebuilt') asset = await new SkillStore(data).uploadZip(archive);
  app = await createEvaluationService({rootDirectory: root, dataDirectory: data, publicDirectory: path.resolve('web-dist'), accessToken: token, publicDemo: false});
  const url = await app.listen({host: '127.0.0.1', port: 0});
  const api = async (route, body) => {
    const response = await fetch(url + route, {method: body === undefined ? 'GET' : 'POST',
      headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  };
  const environments = [];
  for (const [type, name] of [['openjiuwen', 'OpenJiuwen Java'], ['agentscope', 'AgentScope Java']]) {
    const fixture = fixtures[type]; assert.equal(fixture.status, 'READY');
    assert.equal(new URL(fixture.baseUrl).hostname, '127.0.0.1');
    const credential = 'FINANCE_CURATED_UI_' + type.toUpperCase() + '_TOKEN';
    process.env[credential] = fixture.token;
    environments.push(await api('/api/environments', {name, type: 'runtime_launcher', runtimeType: type,
      baseUrl: new URL(type + '/', fixture.baseUrl).toString(), credentialEnv: credential}));
  }
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH});
  page = await browser.newPage({viewport: {width: 1366, height: 900}});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button', {name: '进入工作区', exact: true}).click();
  if (flow === 'prebuilt') {
    await page.locator('.skill-list-item').filter({has: page.getByRole('heading', {name: displayName, exact: true})})
      .getByRole('button', {name: '进入评测', exact: true}).click();
  } else {
    await page.getByRole('button', {name: 'Skill 资产', exact: true}).click();
    const uploading = page.waitForResponse(r => r.url().endsWith('/api/skills/upload') && r.request().method() === 'POST');
    await page.locator('input[type=file]').setInputFiles({name: skill.skillId + '.zip', mimeType: 'application/zip', buffer: archive});
    const response = await uploading; assert(response.ok(), await response.text()); asset = await response.json();
    await api(`/api/skills/${asset.assetId}/prepare/manual`, {summary: 'Original curated cases and rubrics; controlled transport, not professional quality acceptance', cases: pack.cases});
    await page.reload();
    await page.getByRole('button', {name: 'Skill 资产', exact: true}).click();
    await page.locator(`#asset-${asset.assetId}`).getByRole('button', {name: '进入评测', exact: true}).click();
  }
  assert.equal(asset.skillId, skill.skillId); assert.equal(asset.version, skill.version);
  assert.equal(asset.artifactSha256, pack.variants.right.artifactSha256);
  await page.getByRole('combobox', {name: /^执行方式/}).selectOption('dual_runtime');
  await page.getByRole('combobox', {name: /^对照组 Runtime/}).selectOption(environments[0].environmentId);
  await page.getByRole('combobox', {name: /^目标组 Runtime/}).selectOption(environments[1].environmentId);
  for (const [key, value] of Object.entries(generation)) await page.getByLabel(key, {exact: true}).fill(String(value));
  await expect(page.getByRole('combobox', {name: /^评分方式/})).toHaveValue('model');
  await expect(page.getByRole('button', {name: '开始测试', exact: true})).toBeEnabled({timeout: 15000});
  await page.screenshot({path: path.join(output, 'desktop-configuration.png'), fullPage: true});
  const creating = page.waitForResponse(r => r.url().endsWith('/api/runs') && r.request().method() === 'POST');
  await page.getByRole('button', {name: '开始测试', exact: true}).click();
  const response = await creating, created = await response.json(); assert(response.ok(), JSON.stringify(created));
  const posted = response.request().postDataJSON();
  assert.equal(posted.runtimeBindings.left.environmentId, environments[0].environmentId);
  assert.equal(posted.runtimeBindings.right.environmentId, environments[1].environmentId);
  assert.deepEqual(posted.executionModel.parameters, generation);
  assert.equal(posted.evaluationMode, 'candidate_runtime_comparison');
  await writeFile(path.join(output, 'submitted.json'), JSON.stringify(posted, null, 2));
  let job;
  const deadline = Date.now() + 900000;
  do {
    job = await api(`/api/runs/${created.jobId}`);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  await writeFile(path.join(output, 'job.json'), JSON.stringify(job, null, 2));
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  assert.equal(job.evidence.length, 2 * pack.cases.length);
  for (const row of job.evidence) {
    assert.equal(row.status, 'completed'); assert.equal(row.runtimeIdentityVerified, true);
    assert.equal(row.metadata.toolEvidenceCollection.status, 'CAPTURED');
    assert(row.metadata.runtimeLockSha256 && row.metadata.executionHistoryRequestId && row.metadata.retainedEvidenceRef);
    assert.deepEqual(row.metadata.declaredModelParameters, generation);
    assert(row.toolCalls.length && row.toolCalls.every(call => call.status === 'completed'));
  }
  assert.equal(new Set(job.evidence.map(row => row.metadata.loadedSkillDigest)).size, 1);
  assert.equal(new Set(job.evidence.map(row => row.metadata.sessionId)).size, job.evidence.length);
  assert.equal(judgeCalls.length, job.evidence.length);
  for (const input of judgeCalls) {
    const evalCase = pack.cases.find(row => row.prompt === input.task); assert(evalCase);
    assert.deepEqual(input.criteria.map(row => row.description), evalCase.rubric.map(row => row.description));
    assert(input.runtimeEvidence?.sourceFacts?.length, 'Judge must receive verified source facts');
  }
  for (const item of job.report.cases) for (const side of ['left', 'right']) {
    assert.equal(item.judge.runtimeComparison[side].status, 'assessed');
    assert.equal(item.judge.runtimeComparison[side].assessment.verdict, 'INDETERMINATE');
  }
  await expect(page.locator('.run-status.completed').first()).toBeVisible({timeout: 15000});
  await expect(page.getByText('运行 Lock', {exact: true}).first()).toBeAttached();
  await expect(page.getByText('A · 独立目标评估', {exact: true})).toBeVisible();
  await expect(page.getByText('B · 独立目标评估', {exact: true})).toBeVisible();
  assert.equal(await page.getByText('持平', {exact: true}).count(), 0);
  for (const width of [1366, 390, 320]) {
    await page.setViewportSize({width, height: width > 400 ? 900 : 844});
    await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(width);
    assert(await page.locator('.runtime-goal-strip').evaluate(node => {
      const boxes = [...node.children].map(child => child.getBoundingClientRect());
      return boxes.every((a, i) => boxes.slice(i + 1).every(b =>
        Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 1 || Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 1))
        && [...node.querySelectorAll('button')].every(button => {
          const a = button.getBoundingClientRect(), b = button.parentElement.getBoundingClientRect();
          return a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
        });
    }), 'Result metrics and download actions must not overlap');
    await page.screenshot({path: path.join(output, `result-${width}.png`), fullPage: true});
  }
  const beforeView = judgeCalls.length;
  await page.reload(); await api(`/api/runs/${created.jobId}`);
  assert.equal(judgeCalls.length, beforeView); assert.deepEqual(errors, []);
  checks.push('Original Skill and development cases, native dynamic builds, same generation parameters, per-case sessions, Lock/history and projected facts');
  checks.push('Real page at 1366/390/320; controlled Judge preserves INDETERMINATE rather than claiming answer quality');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({status: 'PASS', scope: 'CONTROLLED_CURATED_NATIVE_BROWSER', flow,
    skillId: skill.skillId, caseIds: pack.cases.map(row => row.caseId), jobId: job.jobId, checks,
    realModel: 'NOT_RUN', professionalQuality: 'NOT_EVALUATED', sso: 'NOT_TESTED', holdout: 'NOT_IN_BROWSER_COHORT'}, null, 2));
} catch (error) {
  if (page) {await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true});
    await writeFile(path.join(output, 'failure-body.txt'), await page.locator('body').innerText());}
  throw error;
} finally {
  await writeFile(path.join(output, 'judge-calls.json'), JSON.stringify(judgeCalls, null, 2));
  await browser?.close(); await app?.close(); await new Promise(resolve => judge.close(resolve));
}
