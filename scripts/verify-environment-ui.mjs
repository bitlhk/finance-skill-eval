import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createEvaluationService } from '../dist/service/server.js';

const data = await mkdtemp(path.join(os.tmpdir(), 'environment-ui-'));
const app = await createEvaluationService({ rootDirectory: process.cwd(), dataDirectory: data,
  publicDirectory: path.resolve('web-dist'), accessToken: 'environment-ui-test', publicDemo: false });
let browser;
try {
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('finance-eval-token', 'environment-ui-test'));
  await page.goto(origin);
  await page.getByRole('button', { name: '测试环境', exact: true }).click();
  await page.getByRole('button', { name: '添加环境', exact: true }).click();
  await page.getByLabel('环境名称').fill('UI MCP');
  await page.getByLabel('资源类型').selectOption('mcp_streamable_http');
  await page.getByLabel('服务地址').fill('file:///not-an-endpoint');
  await page.locator('.environment-form').getByRole('button', { name: '添加环境', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('服务地址').fill('http://127.0.0.1:5000/mcp');
  await page.locator('.environment-form').getByRole('button', { name: '添加环境', exact: true }).click();
  await expect(page.getByText('UI MCP', { exact: true })).toBeVisible();
  await page.getByTitle('编辑 UI MCP').click();
  await expect(page.getByLabel('资源类型')).toBeDisabled();
  await page.getByLabel('环境名称').fill('Edited MCP');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByText('Edited MCP', { exact: true })).toBeVisible();
  await mkdir('reports/environment-ui', { recursive: true });
  await page.screenshot({ path: 'reports/environment-ui/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'reports/environment-ui/mobile.png', fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile horizontal overflow');
  page.on('dialog', dialog => dialog.accept());
  await page.getByTitle('删除 Edited MCP').click();
  await expect(page.getByText('Edited MCP', { exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log('PASS: create error, create, edit, delete, desktop/mobile, no uncaught errors');
} finally {
  await browser?.close();
  await app.close();
  await rm(data, { recursive: true, force: true });
}
