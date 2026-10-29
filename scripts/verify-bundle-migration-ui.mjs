import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { chromium, expect } from '@playwright/test';
import { zipSync, unzipSync } from 'fflate';
import { createEvaluationService } from '../dist/service/server.js';

// Real UI and API; deterministic Agent/Runtime/Judge ports, not business-model acceptance.
const root = process.cwd(),
  data = await mkdtemp(path.join(os.tmpdir(), 'bundle-ui-')),
  token = 'bundle-ui-local';
const screenshotDir = path.join(root, 'artifacts', 'bundle-ui');
await mkdir(screenshotDir, { recursive: true });
const caps = {
  schemaVersion: 'finance.skill-eval.runtime-capabilities.v1',
  runtime: { type: 'openjiuwen', version: 'fixture' },
  models: [{ modelId: 'execution', upstreamModelId: 'fixture' }],
  defaultModelId: 'execution',
  features: {
    streaming: false,
    asyncLaunch: false,
    packagedMcp: true,
    externalMcp: true,
    inlineSecrets: true,
    multiSkill: true,
  },
  limits: { maxArchiveBytes: 8388608, maxFiles: 1000, maxTimeoutMs: 900000, maxConcurrentInstances: 2 },
};
const host = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(caps));
});
await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + host.address().port + '/';
const bundlePorts = {
  agent: async (input) => {
    assert([1,3].includes(input.base.members.length));
    if (input.mode === 'ANALYZE')
      return {
        status: 'PRODUCED',
        analysis: {
          summary: '统一预算查询与规则检查的金额契约。',
          changes: [
            { paths: ['skills/budget/SKILL.md', 'skills/rules/SKILL.md'], reason: '跨 Skill 单位一致性' },
          ],
          missing: [],
        },
      };
    const files = { ...input.base.files };
    if (input.mode === 'REPAIR')
      for (const name of ['budget', 'rules'])
        files['skills/' + name + '/SKILL.md'] = Buffer.from(
          Buffer.from(files['skills/' + name + '/SKILL.md'], 'base64')
            .toString()
            .replace('cents', 'yuan'),
        ).toString('base64');
    return {
      status: 'PRODUCED',
      files,
      delivery: {
        summary: input.mode === 'REPAIR' ? '已跨两个 Skill 修复金额单位' : '整组初始迁移完成',
        services: [],
      },
    };
  },
  runtime: async ({ snapshot }) => ({
    model: { providerId: 'fixture', modelId: 'execution', parameters: {} },
    environmentSnapshot: { fixture: true },
    runtime: {
      adapterId: 'ui-fixture',
      prepare: async () => {},
      cleanup: async () => {},
      execute: async (request) => ({
        runId: request.runId,
        side: 'right',
        caseId: request.evalCase.caseId,
        modelId: 'execution',
        skillVersion: 'frozen',
        status: 'completed',
        output: Buffer.from(snapshot.files[Object.keys(snapshot.files).find(name => name.endsWith('skills/budget/SKILL.md'))], 'base64').toString().includes('cents')
          ? '错误：预算充足'
          : '正确：预算不足',
        elapsedMs: 1,
        toolCalls: [],
        loadedSkills: snapshot.members.map((m) => ({ skillId: m.skillId, version: m.version })),
        usage: null,
        runtimeIdentityVerified: true,
        streamCompleted: true,
        error: null,
        metadata: { contentDigest: snapshot.digest, loadedSkillMembers: snapshot.members },
      }),
    },
  }),
  judge: async ({ evidence }) => ({ passed: evidence.output.startsWith('正确'), reason: evidence.output }),
};
const app = await createEvaluationService({
  rootDirectory: root,
  dataDirectory: data,
  publicDirectory: path.join(root, 'web-dist'),
  accessToken: token,
  publicDemo: false,
  bundlePorts,
});
app.log.level = 'error';
const registration = await app.inject({
  method: 'POST',
  url: '/api/environments',
  headers: { authorization: 'Bearer ' + token },
  payload: { name: '整组测试环境', type: 'runtime_launcher', runtimeType: 'openjiuwen', baseUrl: base },
});
assert.equal(registration.statusCode, 200, registration.body);
const url = await app.listen({ host: '127.0.0.1', port: 0 });
let browser, page;
const errors = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button', { name: '进入工作区', exact: true }).click();
  await page.getByRole('button', { name: 'Skill 迁移', exact: true }).click();
  await page.getByLabel('任务名称', { exact: true }).fill('采购审核整体迁移');
  await page.getByLabel('目标环境与要求', { exact: true }).fill('OpenJiuwen 原生多 Skill');
  await page.getByLabel('业务目标', { exact: true }).fill('由预算查询、规则检查和报告共同完成审核。');
  const archive = zipSync(
    Object.fromEntries(
      ['budget', 'rules', 'report'].map((name) => [
        'skills/' + name + '/SKILL.md',
        Buffer.from(
          '---\nname: ' + name + '\ndescription: ' + name + ' business skill\n---\nAmount in cents.',
        ),
      ]),
    ),
  );
  await page
    .locator('.bundle-panel input[type=file]')
    .first()
    .setInputFiles({ name: 'bundle.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) });
  const stage = (name) =>
    page
      .getByRole('navigation', { name: '迁移步骤' })
      .getByRole('button', { name: new RegExp(name) })
      .click();
  await expect(page.getByRole('heading', { name: '采购审核整体迁移', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '分析 Skill 工程', exact: true }).click();
  await expect(page.getByText('统一预算查询与规则检查的金额契约。', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await stage('生成迁移结果');
  await page.getByRole('button', { name: '生成迁移结果', exact: true }).click();
  await expect(page.getByText('整组初始迁移完成', { exact: true })).toBeVisible({ timeout: 15000 });
  await stage('Runtime 适配与登记');
  await page.getByLabel('已登记执行环境', { exact: true }).selectOption({ label: '整组测试环境' });
  await page.getByRole('button', { name: '保存运行配置', exact: true }).click();
  await page.getByRole('button', { name: '检查运行能力', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('检查通过');
  await stage('任务验收');
  await page
    .getByLabel('验收测试集 JSON', { exact: true })
    .fill(
      JSON.stringify({
        name: '预算审核',
        cases: [{ id: 'over-budget', input: '审核超预算采购', criteria: ['应提示预算不足'] }],
      }),
    );
  await page.getByRole('button', { name: '保存测试集', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  await page.getByRole('button', { name: '开始任务验收', exact: true }).click();
  await expect(page.getByRole('button', { name: '让 Agent 查看工程并修复', exact: true })).toBeEnabled({
    timeout: 15000,
  });
  await page.screenshot({ path: path.join(screenshotDir, 'joint-failure.png'), fullPage: true });
  await page.getByRole('button', { name: '让 Agent 查看工程并修复', exact: true }).click();
  await expect(page.getByText('已跨两个 Skill 修复金额单位', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await stage('任务验收');
  await expect(page.getByText('历史候选的验收记录；当前候选需重新验收。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始任务验收', exact: true }).click();
  await expect(page.getByRole('heading', { name: '通过 · 1/1 个案例通过', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await page.screenshot({ path: path.join(screenshotDir, 'joint-passed.png'), fullPage: true });
  await stage('下载结果');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载已验收交付包', exact: true }).click();
  const download = await downloadPromise;
  const zipped = unzipSync(await readFile(await download.path()));
  assert.equal(JSON.parse(Buffer.from(zipped['migration/manifest.json']).toString()).verified, true);
  assert(zipped['package/skills/report/SKILL.md']);
  await page.setViewportSize({ width: 390, height: 844 });
  await stage('任务验收');
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'Mobile layout overflows',
  );
  await page.screenshot({ path: path.join(screenshotDir, 'mobile.png'), fullPage: true });
  // Existing single-Skill project remains available; continuation creates a new unified task.
  const legacyZip = Buffer.from(zipSync({ 'skills/budget/SKILL.md': Buffer.from('---\nname: budget\ndescription: Query budget\n---\nReturn yuan.') }));
  const uploaded = await app.inject({method:'POST',url:'/api/migrations/upload',headers:{authorization:'Bearer '+token,'content-type':'application/zip'},payload:legacyZip});
  assert.equal(uploaded.statusCode,200,uploaded.body);
  const legacyCreated = await app.inject({method:'POST',url:'/api/migrations',headers:{authorization:'Bearer '+token},payload:{sourceAssetId:uploaded.json().assetId,name:'历史单 Skill 任务'}});
  assert.equal(legacyCreated.statusCode,200,legacyCreated.body);
  const legacyBefore = legacyCreated.json();
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'旧版任务记录',exact:true}).click();
  await expect(page.getByRole('button',{name:'新建迁移',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'转入统一迁移',exact:true}).click();
  const transfer = page.getByRole('region',{name:'转入统一迁移'});
  await transfer.getByLabel('业务目标').fill('查询真实预算并判断采购');
  await transfer.getByLabel('目标环境与要求').fill('OpenJiuwen');
  await transfer.getByRole('button',{name:'创建统一任务',exact:true}).click();
  await expect(page.getByRole('heading',{name:'历史单 Skill 任务',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'单个 Skill 迁移',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'分析 Skill 工程',exact:true}).click();
  await expect(page.getByText('统一预算查询与规则检查的金额契约。',{exact:true})).toBeVisible();
  await stage('生成迁移结果');
  await page.getByRole('button',{name:'生成迁移结果',exact:true}).click();
  await expect(page.getByText('整组初始迁移完成',{exact:true})).toBeVisible();
  await stage('Runtime 适配与登记');
  await page.getByLabel('已登记执行环境',{exact:true}).selectOption({label:'整组测试环境'});
  await page.getByRole('button',{name:'保存运行配置',exact:true}).click();
  await stage('任务验收');
  await page.getByLabel('验收测试集 JSON',{exact:true}).fill(JSON.stringify({name:'单 Skill 任务',cases:[{id:'budget',input:'审核预算',criteria:['预算不足时拒绝']}]}));
  await page.getByRole('button',{name:'保存测试集',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  await page.getByRole('button',{name:'开始任务验收',exact:true}).click();
  await expect(page.getByRole('heading',{name:'通过 · 1/1 个案例通过',exact:true})).toBeVisible({timeout:15000});
  await page.getByText('任务与排障标识',{exact:true}).click();
  await expect(page.getByText('来源旧任务：',{exact:false})).toBeVisible();
  await page.screenshot({path:path.join(screenshotDir,'single-legacy-accepted.png'),fullPage:true});
  const legacyAfter = await app.inject({url:'/api/migrations/'+legacyBefore.id,headers:{authorization:'Bearer '+token}});
  assert.deepEqual(legacyAfter.json(),legacyBefore);
  await stage('下载结果');
  const singleDownload = page.waitForEvent('download');
  await page.getByRole('button',{name:'下载已验收交付包',exact:true}).click();
  const singleZip = unzipSync(await readFile(await (await singleDownload).path()));
  const singleManifest = JSON.parse(Buffer.from(singleZip['migration/manifest.json']).toString());
  assert.equal(singleManifest.verified,true);
  assert.equal(singleManifest.candidate.members.length,1);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: 'passed',
      checks: [
        'whole-import',
        'all-member-agent-input',
        'cross-skill-repair',
        'stale-verdict',
        'joint-retest',
        'verified-export',
        'mobile-layout',
        'single-skill-same-workflow',
        'legacy-ui-transfer',
        'legacy-record-unchanged',
        'single-verified-export',
      ],
      screenshots: screenshotDir,
    }),
  );
} catch (error) {
  if (page)
    await page.screenshot({ path: path.join(screenshotDir, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await app.close();
  await new Promise((resolve) => host.close(resolve));
  assert(path.resolve(data).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(data, { recursive: true, force: true });
}
