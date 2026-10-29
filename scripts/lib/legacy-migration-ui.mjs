import assert from 'node:assert/strict';

/** Seed historical API data, then exercise its supported compatibility UI. */
export async function seedLegacyMigration(page, archive) {
  const project = await page.evaluate(async bytes => {
    const base = new URL('.', location.href);
    const key = base.pathname === '/' ? 'finance-eval-token' : 'finance-eval-token:' + base.pathname;
    const token = localStorage.getItem(key);
    const headers = { authorization: 'Bearer ' + token, 'X-Migration-Authorization': 'Bearer ' + token };
    const call = async (suffix, body, contentType = 'application/json') => {
      const response = await fetch(new URL('api/migrations' + suffix, base), {
        method: 'POST', headers: { ...headers, 'content-type': contentType },
        body: contentType === 'application/zip' ? new Uint8Array(body) : JSON.stringify(body),
      });
      if (!response.ok) throw new Error('Legacy fixture setup failed: HTTP ' + response.status);
      return response.json();
    };
    const asset = await call('/upload', bytes, 'application/zip');
    const task = await call('', { sourceAssetId: asset.assetId, name: asset.displayName + ' 历史迁移', createMode: 'new' });
    await call('/' + task.id + '/inspect', {});
    return task;
  }, Array.from(archive));
  assert(project.id);
  await page.reload();
  await page.getByRole('button', { name: 'Skill 迁移', exact: true }).click();
  await page.getByRole('button', { name: '旧版任务记录', exact: true }).click();
  await page.locator('.migration-project').filter({ has: page.getByText(project.name, { exact: true }) })
    .getByRole('button', { name: '继续处理', exact: true }).click();
  return project;
}
