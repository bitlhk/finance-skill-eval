import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import path from 'node:path';
import { validateValues, validateRuntime, portAvailable, settings } from '../lib/settings.mjs';
const valid = () => ({
  FINANCE_EVAL_DATA_DIR: path.resolve('data'), FINANCE_RUNTIME_CONFIG: path.resolve('runtime.json'),
  FINANCE_EVAL_MIGRATION_PYTHON: path.resolve('python'), FINANCE_EVAL_PORT: '56361', FINANCE_RUNTIME_PORT: '56362',
  FINANCE_EVAL_ACCESS_TOKEN: 'x'.repeat(32), FINANCE_EVAL_JUDGE_API_KEY: 'private-key',
  FINANCE_EVAL_JUDGE_BASE_URL: 'https://example.invalid/v1', FINANCE_EVAL_JUDGE_MODEL: 'judge',
});
test('rejects incomplete production configuration and unsafe defaults', () => {
  validateValues(valid());
  for (const [key, value] of Object.entries({
    FINANCE_EVAL_DATA_DIR: 'relative', FINANCE_EVAL_ACCESS_TOKEN: 'short',
    FINANCE_RUNTIME_PORT: '56361', FINANCE_EVAL_PORT: 'NaN',
    FINANCE_EVAL_JUDGE_API_KEY: 'REPLACE_WITH_API_KEY', FINANCE_EVAL_AGENT_DUMP: '/tmp/dump',
    FINANCE_EVAL_PUBLIC_DEMO: 'true', FINANCE_EVAL_JUDGE_BASE_URL: 'https://user:password@example.invalid',
    FINANCE_EVAL_LOG_LEVEL: 'unknown', FINANCE_EVAL_MAX_CONCURRENT_RUNS: '0',
  })) assert.throws(() => validateValues({ ...valid(), [key]: value }));
  assert.throws(() => validateValues({ ...valid(), FINANCE_RUNTIME_PORT: '056361' }), /PORT_CONFLICT/);
});
test('requires enabled model and matching migration alias', () => {
  const model = { apiKey: 'private', baseUrl: 'https://example.invalid', upstreamModelId: 'model' };
  validateRuntime({ models: { 'enterprise-model': model } });
  assert.throws(() => validateRuntime({ models: { model: { ...model, enabled: false } } }));
  assert.throws(() => validateRuntime({ models: { model } }, 'missing'));
});
test('detects a genuinely occupied port and accepts it after close', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try { await assert.rejects(portAvailable('127.0.0.1', port), /PORT_UNAVAILABLE/); }
  finally { await new Promise(resolve => server.close(resolve)); }
  await portAvailable('127.0.0.1', port);
});
test('defaults loopback and prepends runtime interpreter without shell evaluation', async () => {
  const config = await settings(undefined, { ...valid(), PATH: 'original-path' });
  assert.equal(config.env.NODE_ENV, 'production');
  assert.equal(config.env.FINANCE_EVAL_HOST, '127.0.0.1');
  assert(config.env.PATH.endsWith('original-path'));
});
