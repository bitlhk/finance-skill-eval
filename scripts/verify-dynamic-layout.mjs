import { chromium, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';

const base = 'http://127.0.0.1:56371';
const token = (await readFile('.public-demo/ingress.token', 'utf8')).trim();
const headers = { authorization: `Bearer ${token}`, 'x-demo-user': 'studio_coach_dynamic_smoke', origin: 'https://finance-eval.demo.linggan.top' };
const runs = await fetch(`${base}/api/runs`, { headers }).then(r => r.json());
const job = runs.runs.find(j => j.pack?.targetSkillId === 'goldencoach-stage-evaluation' && j.questionSet);
if (!job) throw new Error('No existing dynamic coach run');
const out = '/tmp/finance-eval-dynamic-layout'; await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
// Rendering-only test: reuse an existing real job, never start or cancel a run.
await page.route(`${base}/api/**`, async route => {
  const r = route.request();
  if (r.method() === 'POST' && r.url() === `${base}/api/runs`) return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(job) });
  if (r.method() === 'POST') {
    if (!r.url().endsWith('/preflight')) throw new Error('Unexpected write');
    const response = await fetch(r.url(), { method: 'POST', headers });
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  }
  return route.continue({ headers: { ...r.headers(), ...headers } });
});
try {
  await page.goto(base);
  await page.locator('.skill-list-item').filter({ has: page.getByRole('heading', { name: '金牌教练', exact: true }) }).getByRole('button', { name: '进入评测' }).click();
  await expect(page.getByRole('button', { name: '开始测试', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '开始测试', exact: true }).click();
  await page.locator('.case-row').first().waitFor();
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await page.waitForTimeout(400);
    const width = await page.locator('.case-copy').first().evaluate(e => e.getBoundingClientRect().width);
    if (width < 180) throw new Error(`Question text column too narrow: ${width}`);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Page overflow');
    await page.locator('.cases-section').screenshot({ path: `${out}/questions-${viewport.width}.png` });
    console.log(JSON.stringify({ mode: 'render-only, existing run', viewport, textWidth: width, errors }));
  }
  if (errors.length) throw new Error(errors.join('; '));
} finally { await page.unrouteAll({ behavior: 'wait' }); await browser.close(); }
