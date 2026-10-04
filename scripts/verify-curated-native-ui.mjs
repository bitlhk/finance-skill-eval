/** Actual UI and native Launchers; explicit live mode still uses a controlled Judge, not quality acceptance. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir, readFile, writeFile, cp} from 'node:fs/promises';
import path from 'node:path';
import {parse as parseYaml} from 'yaml';
import {unzipSync} from 'fflate';
import {chromium, expect} from '@playwright/test';
import {createEvaluationService} from '../dist/service/server.js';
import {SkillStore} from '../dist/service/skill-store.js';
import {loadEvalPack} from '../dist/eval-pack.js';
import {controlledGoalJudge} from './controlled-goal-judge.mjs';
import {fixtureProfile, fixtureExecution} from './native-fixture-profile.mjs';
import {launcherGenerationSchema} from '../dist/runtime-launcher.js';

async function verifyEntry(entry, shared) {
const output = path.resolve(entry.output);
await mkdir(output, {mode: 0o700});
const flow = entry.flow ?? 'prebuilt';
assert(['prebuilt', 'upload', 'migration'].includes(flow));
const paths = JSON.parse(await readFile(entry.fixtures ?? process.env.CURATED_UI_FIXTURES, 'utf8'));
const fixtures = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, file]) =>
  [key, JSON.parse(await readFile(file, 'utf8'))])));
assert.deepEqual(Object.keys(fixtures).sort(), ['agentscope', 'openjiuwen']);
const profile = fixtureProfile(fixtures);
const realModel = fixtureExecution(fixtures, process.env.CURATED_UI_EXECUTION_MODE ?? 'CONTROLLED');
const skill = JSON.parse(await readFile(path.join(entry.skillProbe, 'skill.json'), 'utf8'));
const archive = Buffer.from(skill.archiveBase64, 'base64');
const sourceFiles = unzipSync(archive);
const sourceMethod = Buffer.from(sourceFiles['SKILL.md']).toString();
const sourceHeader = parseYaml(sourceMethod.split('---')[1]);
const declaredTools = sourceHeader['allowed-tools'];
assert(Array.isArray(declaredTools));
if (shared) shared.analysis = {declaredTools, sourceMethod};
const root = shared?.root ?? path.join(output, 'root'), data = shared?.data ?? path.join(output, 'data');
await mkdir(path.join(root, 'packs/finance'), {recursive: true});
if (!shared) await cp(path.join(entry.stagedPack, 'packs/candidate'), path.join(root, 'packs/finance/candidate'), {recursive: true});
await cp('packs/finance/catalog.yaml', path.join(root, 'packs/finance/catalog.yaml'));
if (flow === 'migration') {
  await mkdir(path.join(root, 'scripts'));
  await cp('scripts/scan-migration.py', path.join(root, 'scripts/scan-migration.py'));
}
const pack = await loadEvalPack(path.join(entry.stagedPack, 'packs/candidate/eval.yaml'));
if (!declaredTools.length) assert(pack.cases.every(row => !row.requiredTools.length), 'No-tool method cannot require case tools');
assert.equal(pack.targetSkillId, skill.skillId);
assert.equal(pack.targetSkillVersion, skill.version);
const catalog = parseYaml(await readFile('packs/finance/catalog.yaml', 'utf8'));
const displayName = catalog.skills.find(row => row.skillId === skill.skillId)?.displayName;
assert(displayName, 'Use an actual curated catalog entry');
const token = shared?.token ?? randomBytes(32).toString('hex');
const generation = launcherGenerationSchema.omit({schemaVersion:true}).parse(
  process.env.CURATED_UI_GENERATION ? JSON.parse(process.env.CURATED_UI_GENERATION)
    : {temperature: 0, top_p: 1, max_tokens: 1024});
const modelFile = path.join(output, 'models.json');
await writeFile(modelFile, JSON.stringify({schemaVersion: 'finance.skill-eval.execution-models.v1', defaultModelId: 'launcher-model',
  models: [{providerId: 'managed-launcher', modelId: 'launcher-model', label: realModel==='LIVE'?'Approved live native model':'Controlled native model', availability: 'ready', parameters: generation}]}));
process.env.FINANCE_EVAL_EXECUTION_CATALOG = modelFile;
const judge = shared?.judge ?? await controlledGoalJudge(), judgeCalls = judge.calls, judgeStart = judge.calls.length;
if (shared) shared.judge = judge;
let app, browser, page, asset;
const errors = [], checks = [];
try {
  if (flow === 'prebuilt') asset = await new SkillStore(data).uploadZip(archive);
  app = shared?.app ?? await createEvaluationService({rootDirectory: root, dataDirectory: data, publicDirectory: path.resolve('web-dist'), accessToken: token, publicDemo: false,
    ...(flow === 'migration' || shared?.migration ? {
      migrationAnalyzer: async () => {
        const {declaredTools: tools, sourceMethod: method} = shared?.analysis ?? {declaredTools, sourceMethod};
        return {status: 'PRODUCED', payload: {status: 'PRODUCED', skill: {status: 'COMPLIANT', findings: []},
        tools: tools.map(name => ({name, sourcePaths: ['SKILL.md'], language: null, portability: 'RUNTIME_BOUND',
          input: {description: 'Refer to the admitted contract', schema: null},
          output: {description: 'Refer to the admitted contract', schema: null}, evidence: [], findings: [],
          recommendedForm: 'MCP', recommendationReason: 'Controlled analysis of explicit tool declarations, not inferred bank compatibility'})),
        dependencyAnalysis: {dependencies: [], chains: tools.map(name => ({toolName: name,
          nodes: [{id: 'declaration', title: 'Explicit tool declaration', detail: 'Controlled source citation', dependencyKeys: [],
            evidence: [{path: 'SKILL.md', snippet: method.split('\n').find(line => line.includes(name))}]}], edges: []}))}},
        scanner: {scannerDigest: 'a'.repeat(64), coverage: []}};
      },
      migrationImplementer: async () => {throw Error('Native binding must not generate or run uploaded code');},
    } : {})});
  const url = shared?.url ?? await app.listen({host: '127.0.0.1', port: 0});
  if (shared) Object.assign(shared, {app, url});
  const api = async (route, body) => {
    const response = await fetch(url + route, {method: body === undefined ? 'GET' : 'POST',
      headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  };
  const groups = shared ? (shared.environmentGroups ??= new Map()) : new Map();
  const environments = groups.get(profile.key) ?? [];
  const groupIndex = groups.size;
  if (!environments.length) for (const [type, name] of [['openjiuwen', 'OpenJiuwen Java'], ['agentscope', 'AgentScope Java']]) {
    const fixture = fixtures[type];
    const credential = 'FINANCE_CURATED_UI_' + groupIndex + '_' + type.toUpperCase() + '_TOKEN';
    process.env[credential] = fixture.token;
    environments.push(await api('/api/environments', {name: entry.profileLabel ? entry.profileLabel + ' · ' + name : name,
      type: 'runtime_launcher', runtimeType: type, baseUrl: profile.routes[type], credentialEnv: credential}));
  }
  groups.set(profile.key, environments);
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH});
  page = await browser.newPage({viewport: {width: 1366, height: 900}});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button', {name: '进入工作区', exact: true}).click();
  if (flow === 'prebuilt') {
    await page.locator('.skill-list-item').filter({has: page.getByRole('heading', {name: displayName, exact: true})})
      .getByRole('button', {name: '进入评测', exact: true}).click();
  } else if (flow === 'upload') {
    await page.getByRole('button', {name: 'Skill 资产', exact: true}).click();
    const uploading = page.waitForResponse(r => r.url().endsWith('/api/skills/upload') && r.request().method() === 'POST');
    await page.locator('input[type=file]').setInputFiles({name: skill.skillId + '.zip', mimeType: 'application/zip', buffer: archive});
    const response = await uploading; assert(response.ok(), await response.text()); asset = await response.json();
    await api(`/api/skills/${asset.assetId}/prepare/manual`, {summary: 'Original curated cases and rubrics; controlled transport, not professional quality acceptance', cases: pack.cases});
    await page.reload();
    await page.getByRole('button', {name: 'Skill 资产', exact: true}).click();
    await page.locator(`#asset-${asset.assetId}`).getByRole('button', {name: '进入评测', exact: true}).click();
  } else {
    await page.getByRole('button', {name: 'Skill 迁移', exact: true}).click();
    await page.getByRole('button', {name: '新建迁移', exact: true}).click();
    const inspected = page.waitForResponse(r => r.url().endsWith('/inspect') && r.request().method() === 'POST');
    await page.locator('input[type=file][multiple]').setInputFiles({name: skill.skillId + '.zip', mimeType: 'application/zip', buffer: archive});
    const diagnosis = await inspected; assert(diagnosis.ok(), await diagnosis.text());
    const binding = page.locator('section').filter({has: page.getByRole('heading', {name: '复用已准入工具', exact: true})}).last();
    for (const environment of environments) await binding.getByLabel(environment.name, {exact: true}).check();
    await binding.getByRole('button', {name: '检查已准入合同', exact: true}).click();
    await expect(binding.getByText('所选环境均有对应工具，请核对其真实合同与使用范围。')).toBeVisible();
    await expect(binding.getByRole('button', {name: '绑定并生成候选', exact: true})).toBeDisabled();
    await binding.getByLabel('已核对工具合同和用途；绑定不代表候选已执行通过').check();
    await page.screenshot({path: path.join(output, 'migration-binding.png'), fullPage: true});
    const generatedResponse = page.waitForResponse(r => r.url().endsWith('/native-candidate') && r.request().method() === 'POST');
    await binding.getByRole('button', {name: '绑定并生成候选', exact: true}).click();
    const response = await generatedResponse, generated = await response.json(); assert(response.ok(), JSON.stringify(generated));
    asset = generated.candidate;
    assert.equal(generated.nativeBindings.bindings.targets.length, 2);
    assert.equal(generated.nativeBindings.candidateDigest, asset.artifactSha256);
    // Eval's immutable file fingerprint and Launcher archive fingerprint have
    // different canonical representations; compare like-for-like identities.
    assert.equal(generated.source.artifactSha256, pack.variants.right.artifactSha256);
    await writeFile(path.join(output, 'migration.json'), JSON.stringify(generated, null, 2));
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', {name: '下载候选', exact: true}).click();
    const download = await downloaded, candidatePath = path.join(output, 'candidate.zip'); await download.saveAs(candidatePath);
    const files = unzipSync(await readFile(candidatePath));
    assert(Buffer.from(files['SKILL.md']).toString().includes(sourceMethod.split('---').slice(2).join('---').trim()));
    for (const [name, bytes] of Object.entries(sourceFiles)) if (name !== 'SKILL.md') assert.deepEqual(files[name], bytes);
    assert.deepEqual(JSON.parse(Buffer.from(files['references/finance-native-bindings.txt']).toString()), generated.nativeBindings.bindings);
    const migrationReport = await api(`/api/migrations/${generated.id}/report`);
    assert.equal(migrationReport.verification.targetExecution, 'NOT_RUN');
    await page.getByRole('button', {name: '在 Skill 资产中继续测试', exact: true}).click();
    await expect(page.locator(`#asset-${asset.assetId}`)).toBeVisible();
    await api(`/api/skills/${asset.assetId}/prepare/manual`, {summary: 'Original cases for the migrated candidate; controlled, not professional acceptance', cases: pack.cases});
    await page.reload();
    await page.getByRole('button', {name: 'Skill 资产', exact: true}).click();
    await page.locator(`#asset-${asset.assetId}`).getByRole('button', {name: '进入评测', exact: true}).click();
  }
  assert.equal(asset.skillId, skill.skillId);
  if (flow !== 'migration') {
    assert.equal(asset.version, skill.version);
    assert.equal(asset.artifactSha256, pack.variants.right.artifactSha256);
  } else assert.notEqual(asset.artifactSha256, pack.variants.right.artifactSha256);
  await page.getByRole('combobox', {name: /^执行方式/}).selectOption('dual_runtime');
  await page.getByRole('combobox', {name: /^对照组 Runtime/}).selectOption(environments[0].environmentId);
  await page.getByRole('combobox', {name: /^目标组 Runtime/}).selectOption(environments[1].environmentId);
  for (const key of ['temperature','top_p','max_tokens']) await page.getByLabel(key, {exact: true}).fill(String(generation[key]));
  const thinkingMode = page.getByRole('combobox', {name:'思考模式', exact:true});
  await expect(thinkingMode).toHaveValue('default');
  if (generation.thinking) {
    await thinkingMode.selectOption('disabled');
    await expect(thinkingMode).toHaveValue('disabled');
    await thinkingMode.selectOption('default');
    await expect(thinkingMode).toHaveValue('default');
    await thinkingMode.selectOption('disabled');
  }
  for (const width of [1366,390,320]) {
    await page.setViewportSize({width,height:width>400?900:844});
    await expect.poll(()=>page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth))).toBeLessThanOrEqual(width);
    const mode=thinkingMode;
    await mode.scrollIntoViewIfNeeded();
    assert(await mode.evaluate(node=>{const a=node.getBoundingClientRect(),b=node.parentElement.getBoundingClientRect();return a.width>80&&a.left>=b.left-1&&a.right<=b.right+1;}));
    await page.screenshot({path:path.join(output,`configuration-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1366,height:900});
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
    assert.equal(row.skillVersion, asset.version);
    if (declaredTools.length) assert.equal(row.metadata.toolEvidenceCollection.status, 'CAPTURED');
    else assert.deepEqual(row.metadata.toolEvidence, []);
    assert(row.metadata.runtimeLockSha256 && row.metadata.executionHistoryRequestId && row.metadata.retainedEvidenceRef);
    assert.deepEqual(row.metadata.declaredModelParameters, generation);
    if (declaredTools.length) assert(row.toolCalls.length && row.toolCalls.every(call => call.status === 'completed'));
    else assert.deepEqual(row.toolCalls, []);
  }
  assert.equal(new Set(job.evidence.map(row => row.metadata.loadedSkillDigest)).size, 1);
  assert.equal(new Set(job.evidence.map(row => row.metadata.sessionId)).size, job.evidence.length);
  assert.equal(judgeCalls.length - judgeStart, job.evidence.length);
  for (const input of judgeCalls.slice(judgeStart)) {
    const evalCase = pack.cases.find(row => row.prompt === input.task); assert(evalCase);
    assert.deepEqual(input.criteria.map(row => row.description), evalCase.rubric.map(row => row.description));
    if (declaredTools.length) assert(input.runtimeEvidence?.sourceFacts?.length, 'Judge must receive verified source facts');
    else assert(!input.runtimeEvidence?.sourceFacts?.length, 'No-tool method must not invent source facts');
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
  if (shared) {
    shared.jobIds.push(job.jobId);
    for (const id of shared.jobIds) assert.equal((await api(`/api/runs/${id}`)).status, 'completed');
  }
  checks.push('Original Skill and development cases, native dynamic builds, same generation parameters, per-case sessions, Lock/history and projected facts');
  checks.push('Real page at 1366/390/320; controlled Judge preserves INDETERMINATE rather than claiming answer quality');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({status: 'PASS', scope: realModel==='LIVE'?'LIVE_CURATED_NATIVE_BROWSER_CONTROLLED_JUDGE':'CONTROLLED_CURATED_NATIVE_BROWSER', flow,
    skillId: skill.skillId, caseIds: pack.cases.map(row => row.caseId), jobId: job.jobId, checks,
    analysis: flow === 'migration' ? 'CONTROLLED_EXPLICIT_DECLARATIONS' : 'NOT_RUN',
    sourceScope: 'Previously adapted readonly Skill; not arbitrary MCP code migration',
    realModel, judgeMode:'CONTROLLED', professionalQuality: 'NOT_EVALUATED', sso: 'NOT_TESTED', holdout: 'NOT_IN_BROWSER_COHORT'}, null, 2));
} catch (error) {
  if (page) {await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true});
    await writeFile(path.join(output, 'failure-body.txt'), await page.locator('body').innerText());}
  throw error;
} finally {
  await writeFile(path.join(output, 'judge-calls.json'), JSON.stringify(judgeCalls.slice(judgeStart), null, 2));
  await browser?.close();
  if (!shared) {await app?.close(); await judge.close();}
}
}

if (process.env.CURATED_UI_COHORT) {
  const output = path.resolve(process.env.CURATED_UI_OUTPUT);
  await mkdir(output, {mode: 0o700});
  const entries = JSON.parse(await readFile(process.env.CURATED_UI_COHORT, 'utf8'));
  assert(Array.isArray(entries) && entries.length > 1);
  assert(entries.every(entry => ['prebuilt', 'upload', 'migration'].includes(entry.flow ?? 'prebuilt')));
  const shared = {root: path.join(output, 'root'), data: path.join(output, 'data'),
    token: randomBytes(32).toString('hex'), jobIds: [], migration: entries.some(entry => entry.flow === 'migration')};
  await mkdir(path.join(shared.root, 'packs/finance'), {recursive: true});
  const packs = new Set();
  for (const entry of entries) {
    const directory = path.join(entry.stagedPack, 'packs/candidate');
    const pack = await loadEvalPack(path.join(directory, 'eval.yaml'));
    if (packs.has(pack.packId)) continue;
    await cp(directory, path.join(shared.root, 'packs/finance', String(packs.size)), {recursive: true});
    packs.add(pack.packId);
  }
  try {
    for (const [index, entry] of entries.entries()) {
      await verifyEntry({...entry, output: path.join(output, 'entry-' + index)}, shared);
    }
    await writeFile(path.join(output, 'report.json'), JSON.stringify({status: 'PASS',
      scope: 'SAME_EVAL_SERVICE_AND_WORKSPACE', jobIds: shared.jobIds, serviceRestarts: 0,
      environmentCount: [...shared.environmentGroups.values()].reduce((sum, rows) => sum + rows.length, 0),
      managedProfileCount: shared.environmentGroups.size,
      realModel: process.env.CURATED_UI_EXECUTION_MODE==='LIVE'?'LIVE':'NOT_RUN',
      judgeMode:'CONTROLLED', professionalQuality:'NOT_EVALUATED', sso: 'NOT_TESTED'}, null, 2));
  } finally {await shared.app?.close(); await shared.judge?.close();}
} else {
  await verifyEntry({output: process.env.CURATED_UI_OUTPUT, flow: process.env.CURATED_UI_FLOW,
    skillProbe: process.env.CURATED_UI_SKILL_PROBE, stagedPack: process.env.CURATED_UI_STAGING});
}
