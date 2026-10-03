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
  for (const [type, name] of [['openjiuwen', 'OpenJiuwen Java'], ['agentscope', 'AgentScope Java']]) {
    await api('/api/environments', {name, type: 'runtime_launcher', runtimeType: type,
      baseUrl: `http://127.0.0.1:${fixture.address().port}/${type}/`});
  }
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH});
  page = await browser.newPage({viewport: {width: 1366, height: 900}});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button', {name: '进入工作区', exact: true}).click();
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
  await expect(page.locator(`#asset-${generated.candidate.assetId}`)).toBeVisible();
  assert.deepEqual(errors, []);
  assert(calls.filter(c => c.path.endsWith('/v1/native-tool-catalog')).length >= 4);
  assert(calls.every(c => c.method === 'GET' && /\/v1\/(native-tool-catalog|runtime-capabilities)$/u.test(c.path)));
  checks.push('Candidate reachable in Skill assets; desktop, 390px and 320px; no model, bank or Runtime execution');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({status: 'PASS', scope: 'CONTROLLED_MIGRATION_UI_ONLY',
    analysis: 'CONTROLLED', catalogs: 'CONTROLLED', runtimeExecution: 'NOT_RUN', realModel: 'NOT_RUN', sso: 'NOT_TESTED',
    deployed: false, checks, calls, candidateDigest: generated.candidate.artifactSha256}, null, 2));
} catch (error) {
  if (page) {await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true});
    await writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText());}
  throw error;
} finally {
  await browser?.close(); await app?.close(); await new Promise(resolve => fixture.close(resolve));
}
