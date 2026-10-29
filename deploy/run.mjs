import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { args, settings, preflight, fail } from './lib/settings.mjs';

const options = args(), command = options._?.[0], component = options._?.[1] || command;
const log = (event, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), component: 'supervisor', event, ...fields }));
try {
  if (!['api', 'runtime'].includes(component)) fail('USAGE_RUN_API_RUNTIME_OR_STOP_COMPONENT');
  const config = await settings(options.env), { env, root } = config;
  if (!env.FINANCE_EVAL_DATA_DIR || !path.isAbsolute(env.FINANCE_EVAL_DATA_DIR)) fail('ABSOLUTE_DATA_DIRECTORY_REQUIRED');
  const directory = path.join(env.FINANCE_EVAL_DATA_DIR, 'processes'), stateFile = path.join(directory, component + '.json');
  if (command === 'stop') {
    let state;
    try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch (error) { if (error.code === 'ENOENT') process.exit(0); throw error; }
    const response = await fetch(`http://127.0.0.1:${state.port}/stop`, { method: 'POST', headers: { authorization: 'Bearer ' + state.token }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) fail('STOP_REJECTED');
    const deadline = Date.now() + 65000;
    while (Date.now() < deadline) {
      try { await readFile(stateFile); } catch (error) { if (error.code === 'ENOENT') process.exit(0); throw error; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    fail('STOP_TIMEOUT');
  }
  await preflight(config, { component, ports: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const old = JSON.parse(await readFile(stateFile, 'utf8'));
    // Containers often reuse the same PID after restart. A state file bearing
    // our own PID predates this invocation and cannot belong to another owner.
    let alive = old.pid !== process.pid;
    if (alive) {
      try { process.kill(old.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    }
    if (alive) fail('SUPERVISOR_ALREADY_RUNNING_OR_STALE_PID_REQUIRES_REVIEW');
    await unlink(stateFile);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = randomBytes(32).toString('hex');
  await writeFile(stateFile, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
  let child, stopping = false, timer;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('supervisor_stopping', { service: component });
    if (component === 'api' && child?.connected) child.send({ type: 'finance.shutdown' });
    else if (child?.stdin?.writable) child.stdin.end('stop\n');
    timer = setTimeout(() => {
      log('supervisor_force_stop', { service: component });
      if (!child?.pid) return;
      if (process.platform === 'win32') {
        const kill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        kill.on('error', () => child.kill('SIGKILL'));
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }, 50000);
  };
  const control = createServer((request, reply) => {
    const supplied = Buffer.from(request.headers.authorization || ''), expected = Buffer.from('Bearer ' + token);
    if (request.url !== '/stop' || request.method !== 'POST' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      reply.writeHead(403).end(); return;
    }
    reply.writeHead(202).end(); stop();
  });
  await new Promise(resolve => control.listen(0, '127.0.0.1', resolve));
  await writeFile(stateFile, JSON.stringify({ pid: process.pid, port: control.address().port, token }), { mode: 0o600 });
  const executable = component === 'api' ? process.execPath : config.python;
  const parameters = component === 'api' ? ['dist/service/server.js'] : ['-m', 'integrations.openjiuwen.serve'];
  child = spawn(executable, parameters, { cwd: root, env, windowsHide: true, detached: process.platform !== 'win32',
    stdio: component === 'api' ? ['ignore', 'inherit', 'inherit', 'ipc'] : ['pipe', 'inherit', 'inherit'] });
  let cleaned = false;
  const finish = async code => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    control.close();
    await unlink(stateFile).catch(() => {});
    log('supervisor_exited', { service: component, exitCode: code });
    process.exitCode = code;
  };
  child.once('error', () => void finish(1));
  child.once('exit', code => void finish(code ?? 1));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log('supervisor_started', { service: component, pid: child.pid });
} catch (error) {
  log('supervisor_failed', { code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'CHECK_CONFIGURATION_AND_SERVICE_LOGS' });
  process.exitCode = 1;
}
