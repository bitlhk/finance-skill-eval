// Genuine built API + installed OpenJiuwen worker. No model endpoint substitutes.
// This checks deployment mechanics; model behavior is covered by bundle:live.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { args, settings } from '../deploy/lib/settings.mjs';
const options = args(), config = await settings(options.env);
const root = config.root, temp = await mkdtemp(path.join(tmpdir(), 'finance-production-'));
const reportDirectory = path.resolve(options.output || 'reports/production-smoke-' + Date.now());
await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
const checks = [], children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return String(value);
}
const env = { ...config.env, FINANCE_EVAL_DATA_DIR: path.join(temp, 'data'),
  FINANCE_EVAL_ACCESS_TOKEN: randomBytes(32).toString('hex'),
  FINANCE_EVAL_PUBLIC_DEMO: 'false',
  FINANCE_EVAL_PORT: await port(), FINANCE_RUNTIME_PORT: await port(),
  FINANCE_EVAL_HOST: '127.0.0.1', FINANCE_RUNTIME_HOST: '127.0.0.1' };
delete env.FINANCE_EVAL_AGENT_DUMP;
function launch(parameters, overrides = {}) {
  const child = spawn(process.execPath, parameters, { cwd: root, env: { ...env, ...overrides }, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  const item = { child, output: '', code: undefined };
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { item.output = (item.output + chunk).slice(-2000000); });
  item.done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { item.code = code; resolve(code); });
  });
  children.push(item);
  return item;
}
async function command(parameters, overrides) {
  const item = launch(parameters, overrides);
  let timer;
  try {
    const code = await Promise.race([item.done, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('COMMAND_TIMEOUT')), 90000);
    })]);
    return { code, output: item.output };
  } finally { clearTimeout(timer); }
}
async function waitReady(component) {
  const url = component === 'api' ? 'http://127.0.0.1:' + env.FINANCE_EVAL_PORT + '/api/health'
    : 'http://127.0.0.1:' + env.FINANCE_RUNTIME_PORT + '/v1/runtime-capabilities';
  for (let attempt = 0; attempt < 180; attempt++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return; } catch {}
    await sleep(500);
  }
  throw new Error('STARTUP_TIMEOUT_' + component.toUpperCase());
}
async function stop(component) {
  assert.equal((await command(['deploy/run.mjs','stop',component])).code, 0, 'GRACEFUL_STOP_FAILED');
}
function pass(name) { checks.push(name); console.log('PASS ' + name); }
let status = 'FAILED', failure;
try {
  assert.equal((await command(['deploy/preflight.mjs','--ports'])).code, 0, 'PREFLIGHT_FAILED');
  pass('real SDK imports, production configuration, disk and ports');
  const bad = await command(['deploy/run.mjs','api'], { FINANCE_EVAL_ACCESS_TOKEN: 'short' });
  assert.notEqual(bad.code, 0);
  assert(!bad.output.includes(env.FINANCE_EVAL_JUDGE_API_KEY));
  pass('invalid configuration fails before listen without credential output');
  launch(['deploy/run.mjs','runtime']);
  await waitReady('runtime');
  const api = launch(['deploy/run.mjs','api']);
  await waitReady('api');
  assert.equal((await command(['deploy/health.mjs'])).code, 0, 'HEALTH_FAILED');
  pass('real API and Runtime start; authentication and multi-skill capability');
  assert.notEqual((await command(['deploy/run.mjs','api'])).code, 0);
  assert.equal((await command(['deploy/health.mjs'])).code, 0);
  pass('duplicate start rejected without disrupting the running service');
  const canary = 'production-secret-canary-7da819';
  const response = await fetch('http://127.0.0.1:' + env.FINANCE_EVAL_PORT + '/api/health?token=' + canary,
    { headers: { authorization: 'Bearer ' + canary, 'x-request-id': canary } });
  assert(response.headers.get('x-request-id'));
  await sleep(100);
  assert(!api.output.includes(canary));
  pass('real HTTP request correlation excludes query and authorization canaries');
  await stop('api');
  await api.done;
  assert.equal(api.code, 0);
  assert(api.output.includes('service_stopped'));
  pass('API close hooks complete through supervisor IPC');
  const crashing = launch(['deploy/run.mjs','api']);
  await waitReady('api');
  const started = crashing.output.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } })
    .find(row => row.event === 'supervisor_started');
  assert(started?.pid);
  process.kill(started.pid, 'SIGKILL');
  await crashing.done;
  assert.notEqual(crashing.code, 0);
  launch(['deploy/run.mjs','api']);
  await waitReady('api');
  pass('abrupt API exit propagates failure; a fresh start recovers');
  await stop('api');
  await stop('runtime');
  await Promise.all(children.map(item => item.done));
  pass('Runtime stdin shutdown and process-state cleanup');
  await stop('api');
  pass('repeated stop is idempotent');
  status = 'PASSED';
} catch (error) {
  const category = error.message.split('\n')[0];
  failure = /^[A-Z0-9_]+$/.test(category) ? category : 'ASSERTION_FAILED';
  process.exitCode = 1;
} finally {
  for (const component of ['api','runtime']) {
    try { await stop(component); } catch {}
  }
  for (const item of children) if (item.code === undefined) item.child.kill();
  // Only our own freshly allocated directory is removed.
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(tmpdir()));
  assert(path.basename(temp).startsWith('finance-production-'));
  await rm(temp, { recursive: true, force: true });
  await writeFile(path.join(reportDirectory, 'result.json'), JSON.stringify({
    status, checks, failure, modelExecution: 'NOT_TESTED', services: 'REAL_API_AND_OPENJIUWEN',
    platform: process.platform, node: process.version, completedAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status, reportDirectory, failure }));
}
