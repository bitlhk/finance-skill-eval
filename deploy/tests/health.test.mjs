import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('health verifies the current task route and rejects incorrect authentication', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'finance-health-'));
  const file = path.join(directory, '.env.local');
  const seen = [];
  let catalogStatus = 200;
  const runtime = {
    schemaVersion: 'finance.runtime-capabilities.v1', instanceSchemaVersion: 'finance.runtime-instance.v1',
    platform: { os: 'linux', arch: 'x64', isolation: 'trusted_local_process' },
    runtime: { type: 'openjiuwen', version: 'test' }, models: [{ modelId: 'test', upstreamModelId: 'test' }], defaultModelId: 'test',
    features: { streaming: true, asyncLaunch: false, packagedMcp: true, externalMcp: true, inlineSecrets: true },
    limits: { maxSkills: 10, maxArchiveBytes: 1000, maxFiles: 10, maxTimeoutMs: 1000, maxConcurrentInstances: 1 },
  };
  const server = createServer((request, response) => {
    seen.push(request.url);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/health') response.end(JSON.stringify({ status: 'ready' }));
    else if (request.url === '/api/catalog') { response.statusCode = catalogStatus; response.end('{}'); }
    else if (request.url === '/v1/runtime-capabilities') response.end(JSON.stringify(runtime));
    else if (request.url === '/api/migration-tasks') {
      response.statusCode = request.headers.authorization === 'Bearer fixture-token' ? 200 : 401;
      response.end('[]');
    } else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = () => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../health.mjs', import.meta.url)), '--env', file, '--api', base, '--runtime', base]);
  try {
    await writeFile(file, 'FINANCE_EVAL_ACCESS_TOKEN=fixture-token\n');
    assert.equal(JSON.parse((await run()).stdout).status, 'PASSED');
    assert(seen.includes('/api/migration-tasks'));
    await writeFile(file, 'FINANCE_EVAL_ACCESS_TOKEN=wrong-token\n');
    await assert.rejects(run(), error => error.stderr.includes('AUTHENTICATED_WORKSPACE_NOT_READY'));
    await writeFile(file, 'FINANCE_EVAL_ACCESS_TOKEN=fixture-token\n');
    runtime.limits.maxSkills = 1;
    await assert.rejects(run(), error => error.stderr.includes('MULTI_SKILL_RUNTIME_NOT_READY'));
    runtime.limits.maxSkills = 10;
    catalogStatus = 400;
    await assert.rejects(run(), error => error.stderr.includes('WORKSPACE_CATALOG_NOT_READY'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
