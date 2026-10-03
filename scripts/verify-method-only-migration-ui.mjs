/** Real service/browser; controlled analysis and catalogs, no Runtime execution or SSO claim. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium, expect} from '@playwright/test';
import {zipSync, unzipSync} from 'fflate';
import {createEvaluationService} from '../dist/service/server.js';
import {canonicalSha256} from '../dist/shared/json-canonicalization.js';

assert(process.env.METHOD_ONLY_UI_OUTPUT, 'Set METHOD_ONLY_UI_OUTPUT to a new isolated evidence directory');
const output = path.resolve(process.env.METHOD_ONLY_UI_OUTPUT);
await mkdir(output, {mode: 0o700});
const token = randomBytes(32).toString('hex');
const nativePaths = process.env.METHOD_ONLY_NATIVE_FIXTURES
  ? JSON.parse(await readFile(process.env.METHOD_ONLY_NATIVE_FIXTURES, 'utf8')) : null;
const native = nativePaths ? Object.fromEntries(await Promise.all(Object.entries(nativePaths).map(async ([type, file]) =>
  [type, JSON.parse(await readFile(file, 'utf8'))]))) : null;
const flow = process.env.METHOD_ONLY_UI_FLOW ?? 'migration';
assert(['migration', 'upload'].includes(flow));
const source = '---\nname: supplied-dialogue-review\nversion: 1.0.0\ndescription: Review only the supplied synthetic dialogue.\nallowed-tools: []\n---\nReview the supplied dialogue and cite its evidence. Ask for missing information.\n';
const reference = 'Only supplied dialogue is evidence. No customer or bank lookup is available.\n';
const calls = [];
const catalogs = Object.fromEntries(['openjiuwen', 'agentscope'].map(type => {
  const body = {schemaVersion: 'finance.native-tool-catalog.v1', runtime: {type, version: type === 'openjiuwen' ? '0.1.15' : '2.0.3'},
    deploymentId: 'controlled-ui-' + type, artifactSha256: 'd'.repeat(64), contracts: []};
  return [type, {...body, catalogDigest: canonicalSha256(body)}];
}));
const fixture = http.createServer((req, res) => {
  calls.push({method: req.method, path: req.url});
  const match = /^\/(openjiuwen|agentscope)\/v1\/(native-tool-catalog|runtime-capabilities)$/u.exec(req.url);
  if (req.method !== 'GET' || !match) {res.writeHead(404); res.end(); return;}
  const value = match[2] === 'native-tool-catalog' ? catalogs[match[1]] : {
    schemaVersion: 'finance.skill-eval.runtime-capabilities.v1', runtime: catalogs[match[1]].runtime,
    models: [{modelId: 'controlled-ui', upstreamModelId: 'controlled-ui'}], defaultModelId: 'controlled-ui',
    features: {streaming: false, asyncLaunch: false, packagedMcp: false, externalMcp: false, inlineSecrets: false},
    limits: {maxArchiveBytes: 8000000, maxFiles: 500, maxTimeoutMs: 300000, maxConcurrentInstances: 1}};
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
let app, browser, page;
const checks = [], errors = [];
try {
  if (native) {
    assert.deepEqual(Object.keys(native).sort(), ['agentscope', 'openjiuwen']);
    for (const type of Object.keys(native)) {
      assert.equal(native[type].status, 'READY');
      assert.equal(new URL(native[type].baseUrl).hostname, '127.0.0.1');
      process.env['FINANCE_METHOD_UI_' + type.toUpperCase() + '_TOKEN'] = native[type].token;
    }
    const modelFile = path.join(output, 'models.json');
    await writeFile(modelFile, JSON.stringify({schemaVersion: 'finance.skill-eval.execution-models.v1', defaultModelId: 'launcher-model',
      models: [{providerId: 'managed-launcher', modelId: 'launcher-model', label: 'Controlled native model', availability: 'ready',
        parameters: {temperature: 0, top_p: 1, max_tokens: 1024}}]}));
    process.env.FINANCE_EVAL_EXECUTION_CATALOG = modelFile;
  }
  app = await createEvaluationService({rootDirectory: process.cwd(), dataDirectory: path.join(output, 'data'),
    publicDirectory: path.resolve('web-dist'), accessToken: token, publicDemo: false,
    migrationAnalyzer: async () => ({status: 'PRODUCED', payload: {status: 'PRODUCED', skill: {status: 'COMPLIANT', findings: []},
      tools: [], dependencyAnalysis: {dependencies: [], chains: []}}, scanner: {scannerDigest: 'a'.repeat(64), coverage: []}}),
    migrationImplementer: async () => {throw Error('Method-only binding must not generate executable code');}});
  const url = await app.listen({host: '127.0.0.1', port: 0});
  const api = async (route, body) => {
    const response = await fetch(url + route, {method: body === undefined ? 'GET' : 'POST',
      headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  };
  const environments = [];
  for (const [type, name] of [['openjiuwen', 'OpenJiuwen Java'], ['agentscope', 'AgentScope Java']]) {
    environments.push(await api('/api/environments', {name, type: 'runtime_launcher', runtimeType: type,
      baseUrl: native ? new URL(type + '/', native[type].baseUrl).toString() : `http://127.0.0.1:${fixture.address().port}/${type}/`,
      ...(native ? {credentialEnv: 'FINANCE_METHOD_UI_' + type.toUpperCase() + '_TOKEN'} : {})}));
  }
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH});
  page = await browser.newPage({viewport: {width: 1366, height: 900}});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button', {name: '进入工作区', exact: true}).click();
  let asset;
  if (flow === 'upload') {
    await page.getByRole('button', {name: 'Skill 资产', exact: true}).click();
    const uploaded = page.waitForResponse(r => r.url().endsWith('/api/skills/upload') && r.request().method() === 'POST');
    await page.locator('input[type=file]').setInputFiles({name: 'dialogue-review.zip', mimeType: 'application/zip',
      buffer: Buffer.from(zipSync({'SKILL.md': Buffer.from(source), 'references/evidence.md': Buffer.from(reference)}))});
    const response = await uploaded; assert(response.ok(), await response.text()); asset = await response.json();
    checks.push('Standard Skill ZIP uploaded through browser, no migration or formal publication');
  } else {
  await page.getByRole('button', {name: 'Skill 迁移', exact: true}).click();
  await page.getByRole('button', {name: '新建迁移', exact: true}).click();
  const inspected = page.waitForResponse(r => r.url().endsWith('/inspect') && r.request().method() === 'POST');
  await page.locator('input[type=file][multiple]').setInputFiles({name: 'dialogue-review.zip', mimeType: 'application/zip',
    buffer: Buffer.from(zipSync({'SKILL.md': Buffer.from(source), 'references/evidence.md': Buffer.from(reference)}))});
  const diagnosis = await inspected; assert(diagnosis.ok(), await diagnosis.text());
  const binding = page.locator('section').filter({has: page.getByRole('heading', {name: '复用已准入工具', exact: true})}).last();
  await binding.getByLabel('OpenJiuwen Java', {exact: true}).check();
  await binding.getByLabel('AgentScope Java', {exact: true}).check();
  await binding.getByRole('button', {name: '检查已准入合同', exact: true}).click();
  await expect(binding.getByText(/未发现业务工具依赖/u)).toBeVisible();
  await expect(binding.getByRole('button', {name: '绑定并生成候选', exact: true})).toBeDisabled();
  await binding.getByLabel('已核对方法不需要业务工具；绑定不代表候选已执行通过').check();
  await page.screenshot({path: path.join(output, 'desktop-binding.png'), fullPage: true});
  const generatedResponse = page.waitForResponse(r => r.url().endsWith('/native-candidate') && r.request().method() === 'POST');
  await binding.getByRole('button', {name: '绑定并生成候选', exact: true}).click();
  const response = await generatedResponse, generated = await response.json(); assert(response.ok(), JSON.stringify(generated));
  asset = generated.candidate;
  assert.deepEqual(generated.nativeBindings.bindings.tools, []);
  assert.equal(generated.nativeBindings.bindings.targets.length, 2);
  assert.equal(generated.nativeBindings.candidateDigest, generated.candidate.artifactSha256);
  checks.push('Browser upload, controlled analysis, two catalog checks and explicit empty-tool candidate binding');
  await expect(page.getByText('原生工具候选已保存', {exact: true})).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', {name: '下载候选', exact: true}).click();
  const download = await downloaded, zipPath = path.join(output, 'candidate.zip'); await download.saveAs(zipPath);
  const files = unzipSync(await readFile(zipPath));
  assert(Buffer.from(files['SKILL.md']).toString().includes(source.split('---\n')[2]));
  assert.equal(Buffer.from(files['references/evidence.md']).toString(), reference);
  const frozen = JSON.parse(Buffer.from(files['references/finance-native-bindings.txt']).toString());
  assert.deepEqual(frozen, generated.nativeBindings.bindings);
  const report = await api(`/api/migrations/${generated.id}/report`);
  assert.equal(report.verification.targetExecution, 'NOT_RUN');
  checks.push('Downloaded immutable candidate preserves method and reference; both catalog pins, no fabricated execution');
  await page.screenshot({path: path.join(output, 'desktop-candidate.png'), fullPage: true});
  for (const width of [390, 320]) {
    await page.setViewportSize({width, height: 844});
    await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))).toBeLessThanOrEqual(width);
    await page.screenshot({path: path.join(output, `mobile-${width}.png`), fullPage: true});
  }
  await page.getByRole('button', {name: '在 Skill 资产中继续测试', exact: true}).click();
  }
  await expect(page.locator(`#asset-${asset.assetId}`)).toBeVisible();
  assert.deepEqual(errors, []);
  if (!native && flow === 'migration') assert(calls.filter(c => c.path.endsWith('/v1/native-tool-catalog')).length >= 4);
  assert(calls.every(c => c.method === 'GET' && /\/v1\/(native-tool-catalog|runtime-capabilities)$/u.test(c.path)));
  checks.push('Selected immutable version reachable in Skill assets');
  if (native) {
    await api(`/api/skills/${asset.assetId}/prepare/manual`, {summary: 'Controlled no-tool execution, not quality acceptance',
      cases: [1, 2].map(index => ({caseId: 'dialogue-' + index, name: 'Synthetic dialogue ' + index,
        prompt: 'Review only this supplied synthetic dialogue. UNIQUE_DIALOGUE_' + index, requiredTools: [],
        evaluationGoal: 'Exercise the installed method without business tools', rubric: [{criterionId: 'controlled-response',
          label: 'Controlled output marker', description: 'Transport evidence only', dimension: 'business_completeness', weight: 1,
          anyOf: ['CONTROLLED_COACH_REPLY_NOT_QUALITY_EVALUATION']}]}))});
    await page.setViewportSize({width: 1366, height: 900});
    await page.reload();
    await page.getByRole('button', {name: 'Skill 资产', exact: true}).click();
    await page.locator(`#asset-${asset.assetId}`).getByRole('button', {name: '进入评测', exact: true}).click();
    await page.getByRole('combobox', {name: /^执行方式/u}).selectOption('dual_runtime');
    await page.getByRole('combobox', {name: /^对照组 Runtime/u}).selectOption(environments[0].environmentId);
    await page.getByRole('combobox', {name: /^目标组 Runtime/u}).selectOption(environments[1].environmentId);
    for (const [key, value] of Object.entries({temperature: '0', top_p: '1', max_tokens: '1024'})) await page.getByLabel(key, {exact: true}).fill(value);
    await page.getByRole('combobox', {name: /^评分方式/u}).selectOption('deterministic');
    await expect(page.getByRole('button', {name: '开始测试', exact: true})).toBeEnabled({timeout: 15000});
    await page.screenshot({path: path.join(output, 'native-configuration.png'), fullPage: true});
    const creating = page.waitForResponse(r => r.url().endsWith('/api/runs') && r.request().method() === 'POST');
    await page.getByRole('button', {name: '开始测试', exact: true}).click();
    const response = await creating, created = await response.json(); assert(response.ok(), JSON.stringify(created));
    let job;
    const deadline = Date.now() + 900000;
    do {job = await api(`/api/runs/${created.jobId}`);
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    await writeFile(path.join(output, 'native-job.json'), JSON.stringify(job, null, 2), {mode: 0o600});
    assert.equal(job.status, 'completed', JSON.stringify(job.error)); assert.equal(job.evidence.length, 4);
    for (const row of job.evidence) {
      assert.equal(row.status, 'completed', JSON.stringify(row.error)); assert.equal(row.runtimeIdentityVerified, true);
      assert.deepEqual(row.toolCalls, []); assert.equal(row.skillVersion, asset.version);
      assert.match(row.output, /CONTROLLED_COACH_REPLY_NOT_QUALITY_EVALUATION/u);
      assert(row.metadata.runtimeLockSha256 && row.metadata.executionHistoryRequestId && row.metadata.retainedEvidenceRef);
      assert.deepEqual(row.metadata.declaredModelParameters, {temperature: 0, top_p: 1, max_tokens: 1024});
    }
    assert.equal(new Set(job.evidence.map(row => row.metadata.loadedSkillDigest)).size, 1);
    assert.equal(new Set(job.evidence.map(row => row.metadata.sessionId)).size, 4);
    await expect(page.locator('.run-status.completed').first()).toBeVisible({timeout: 15000});
    await page.screenshot({path: path.join(output, 'native-results.png'), fullPage: true});
    assert.deepEqual(errors, []);
    checks.push('Selected immutable Skill dynamically built on both native Java runtimes; four fresh case sessions, matching method/version, Locks and history');
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify({status: 'PASS', scope: native ? 'CONTROLLED_NATIVE_SKILL_BROWSER' : 'CONTROLLED_MIGRATION_UI_ONLY',
    analysis: flow === 'migration' ? 'CONTROLLED' : 'NOT_RUN', catalogs: flow === 'upload' ? 'NOT_USED' : native ? 'REAL_LAUNCHER' : 'CONTROLLED', runtimeExecution: native ? 'PASSED' : 'NOT_RUN', realModel: 'NOT_RUN', sso: 'NOT_TESTED',
    flow, deployed: false, checks, calls, candidateDigest: asset.artifactSha256}, null, 2));
} catch (error) {
  if (page) {await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true});
    await writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText());}
  throw error;
} finally {
  await browser?.close(); await app?.close(); await new Promise(resolve => fixture.close(resolve));
}
