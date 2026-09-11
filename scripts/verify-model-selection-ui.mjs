import { chromium, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const token = await readFile('.public-demo/ingress.token', 'utf8');
const base = 'http://127.0.0.1:56371', out = '/tmp/finance-eval-models';
const headers = { authorization: `Bearer ${token}`, 'x-demo-user': 'studio_model_smoke', origin: 'https://finance-eval.demo.linggan.top' };
await mkdir(out, { recursive: true });
const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route(`${base}/api/**`, async route => {
  const request = route.request(), combined = { ...request.headers(), ...headers };
  if (request.method() !== 'POST') return route.continue({ headers: combined });
  const r = await fetch(request.url(), { method: 'POST', headers: combined, body: request.postData() ?? undefined });
  return route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() });
});
try {
  await page.goto(base);
  await page.getByRole('button', { name: '进入评测', exact: true }).first().click();
  await page.getByText('在线环境已就绪', { exact: true }).waitFor();
  const panels = page.locator('.comparison-panel');
  const left = panels.nth(0).getByRole('combobox').nth(1), right = panels.nth(1).getByRole('combobox').nth(1);
  await expect(left.locator('option')).toHaveCount(14);
  await expect(right.locator('option')).toHaveCount(14);
  await expect(left.locator('option').filter({ hasText: 'Gemma 4' })).toHaveJSProperty('disabled', true);
  await left.selectOption('service-execution:glm-5.3');
  await right.selectOption('service-execution:glm-5.3-flash');
  await panels.nth(0).getByRole('combobox').nth(0).selectOption('version:2.1.5');
  await page.locator('.case-row input').nth(1).uncheck();
  await expect(page.getByRole('button', { name: '开始测试', exact: true })).toBeEnabled();
  await page.screenshot({ path: `${out}/selection-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile overflow');
  await page.screenshot({ path: `${out}/selection-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const created = page.waitForResponse(r => r.url() === `${base}/api/runs` && r.request().method() === 'POST');
  await page.getByRole('button', { name: '开始测试', exact: true }).click();
  const response = await created, job = await response.json();
  if (response.status() !== 202) throw new Error(JSON.stringify(job));
  if (job.configuration.leftExecutionModel.modelId !== 'glm-5.3' || job.configuration.rightExecutionModel.modelId !== 'glm-5.3-flash') throw new Error('Model selection overwritten');
  console.log(JSON.stringify({ jobId: job.jobId, left: job.configuration.leftExecutionModel.modelId, right: job.configuration.rightExecutionModel.modelId, judge: job.configuration.judgeModel.modelId }));
  let current;
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(4000);
    current = await fetch(`${base}/api/runs/${job.jobId}`, { headers }).then(r => r.json());
    if (i % 10 === 0) console.log(JSON.stringify({ status: current.status, progress: current.progress }));
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status)) break;
  }
  await writeFile(`${out}/result.json`, JSON.stringify(current, null, 2));
  const pair = current.report?.cases[0];
  if (current.status !== 'completed' || pair?.left.status !== 'completed' || pair?.right.status !== 'completed' || !pair.judge || errors.length) throw new Error('Full online model comparison failed');
  if (pair.left.modelId !== 'glm-5.3' || pair.right.modelId !== 'glm-5.3-flash') throw new Error('Execution evidence model mismatch');
  await page.screenshot({ path: `${out}/report-desktop.png`, fullPage: true });
  console.log(JSON.stringify({ status: current.status, summary: current.report.summary, errors }));
} finally {
  await page.unrouteAll({ behavior: 'wait' }); await browser.close();
}
