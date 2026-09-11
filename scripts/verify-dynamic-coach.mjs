import { chromium, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const local = process.argv.includes('--local');
const base = `http://127.0.0.1:${local ? 56361 : 56371}`;
const token = (await readFile('.public-demo/ingress.token', 'utf8')).trim();
// Trusted ingress simulation; this does not test a human platform SSO session.
const headers = { authorization: `Bearer ${token}`, 'x-demo-user': 'studio_coach_dynamic_smoke', origin: 'https://finance-eval.demo.linggan.top' };
const catalog = await fetch(`${base}/api/catalog`, { headers }).then(r => r.json());
const defaultModel = catalog.modelRoles.execution.model;
const selectedModel = process.argv.find(a => a.startsWith('--model='))?.slice(8) ?? defaultModel.modelId;
const out = `reports/goldencoach-dynamic-${new Date().toISOString().replace(/[:.]/g, '-')}${local ? '-local' : ''}-${selectedModel}`;
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], stages = [];
let jobId, current;
page.on('pageerror', e => errors.push(e.message));
await page.route(`${base}/api/**`, async route => {
  const request = route.request();
  if (request.method() === 'POST') {
    const response = await fetch(request.url(), { method: 'POST', body: request.postData() ?? undefined, headers: { ...request.headers(), ...headers } });
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  }
  return route.continue({ headers: { ...request.headers(), ...headers } });
});
try {
  await page.goto(base);
  const card = page.locator('.skill-list-item').filter({ has: page.getByRole('heading', { name: '金牌教练', exact: true }) });
  await expect(card).toContainText('赵印伟');
  await card.getByRole('button', { name: '进入评测' }).click();
  await expect(page.getByRole('button', { name: 'AI 动态出题', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.comparison-panel.target select').first()).toHaveValue('version:2.2.1');
  await expect(page.locator('.comparison-panel.target select').last()).toHaveValue(`${defaultModel.providerId}:${defaultModel.modelId}`);
  if (selectedModel !== defaultModel.modelId) {
    for (const panel of await page.locator('.comparison-panel').all()) await panel.locator('select').last().selectOption(`service-execution:${selectedModel}`);
  }
  await page.getByText('在线环境已就绪', { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/ready-desktop.png`, fullPage: true });
  const response = page.waitForResponse(r => r.url() === `${base}/api/runs` && r.request().method() === 'POST');
  await page.getByRole('button', { name: '开始测试', exact: true }).click();
  const accepted = await response;
  current = await accepted.json();
  if (accepted.status() !== 202) throw new Error(JSON.stringify(current));
  jobId = current.jobId;
  console.log(JSON.stringify({ jobId, caseSource: current.configuration.caseSource }));
  let captured = false;
  for (let i = 0; i < 210; i++) {
    current = await fetch(`${base}/api/runs/${jobId}`, { headers }).then(r => r.json());
    const stage = `${current.status}: ${current.stageLabel}`;
    if (stages.at(-1) !== stage) { stages.push(stage); console.log(stage); }
    if (current.questionSet && !captured) {
      captured = true;
      await page.locator('.case-row').first().waitFor();
      console.log(JSON.stringify({ questions: current.questionSet.cases.map(c => ({ name: c.name, tools: c.requiredTools })), fingerprint: current.questionSet.fingerprint }));
      await page.screenshot({ path: `${out}/dynamic-questions-desktop.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile overflow');
      await page.screenshot({ path: `${out}/dynamic-questions-mobile.png`, fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status)) break;
    await page.waitForTimeout(5000);
  }
  await writeFile(`${out}/run.json`, JSON.stringify(current, null, 2));
  await writeFile(`${out}/verification.json`, JSON.stringify({ stages, errors, jobId, status: current.status, summary: current.report?.summary }, null, 2));
  await page.reload();
  await page.getByRole('button', { name: '运行记录', exact: true }).click();
  await page.getByText(jobId, { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/result-desktop.png`, fullPage: true });
  if (current.status !== 'completed' || !current.questionSet || !current.report?.cases.every(c => c.left.status === 'completed' && c.right.status === 'completed' && c.judge) || errors.length) throw new Error(`Online dynamic verification failed: ${JSON.stringify({ error: current.error, cases: current.report?.cases.map(c => ({ id:c.caseId,left:c.left.error,right:c.right.error,judge:c.judgeError })), errors })}`);
  console.log(JSON.stringify({ status: current.status, caseCount: current.questionSet.cases.length, summary: current.report.summary, errors }));
} finally {
  if (jobId && !['completed', 'failed', 'cancelled', 'interrupted'].includes(current?.status)) await fetch(`${base}/api/runs/${jobId}/cancel`, { method: 'POST', headers });
  await page.unrouteAll({ behavior: 'wait' });
  await browser.close();
}
