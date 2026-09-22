import { createConnection } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { LocalWorker } from '../src/service/local-worker.js';
import { freePort, startService } from '../src/service/service-launch.js';

/**
 * The launcher, without needing a package manager or a model.
 *
 * It is what makes the delivered `start` command real: pick a free port, put it in PORT, wait for
 * the service, and stop the whole process tree afterwards. Everything here runs `node` on a file
 * the test writes, so it is fast and needs no network -- the end-to-end version, against a real
 * MCP service started from a candidate archive, is the browser acceptance script.
 */
const workspaces: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => { for (const workspace of workspaces.splice(0)) await workspace.dispose(); });

const reachable = (port: number) => new Promise<boolean>(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => { socket.destroy(); resolve(false); });
});

const serving = 'import { createServer } from "node:http";\ncreateServer((_request, response) => { response.writeHead(200).end("ok"); }).listen(Number(process.env.PORT), "127.0.0.1");\n';

async function open(worker: LocalWorker, files: Array<{ path: string; content: string }>) {
  const workspace = await worker.open(files.map(file => ({ path: file.path, content: Buffer.from(file.content) })));
  workspaces.push(workspace);
  return workspace;
}

it('starts a delivered service on a free port and tells the caller where it is', async () => {
  const worker = new LocalWorker();
  const workspace = await open(worker, [{ path: 'server.mjs', content: serving }]);
  const started = await startService({ worker, workspace, service: { start: ['node', 'server.mjs'] } });
  expect(started.ok, started.ok ? '' : started.error).toBe(true);
  if (!started.ok) return;
  expect(started.running.endpoint).toBe(`http://127.0.0.1:${started.running.port}/mcp`);
  expect(await reachable(started.running.port)).toBe(true);
  await started.running.stop();
  // Stopping has to free the port, or the next validation runs against a dead service.
  expect(await reachable(started.running.port)).toBe(false);
});

it('runs the preparation step first, and reports one that fails', async () => {
  const worker = new LocalWorker();
  const workspace = await open(worker, [
    { path: 'server.mjs', content: serving },
    { path: 'build.mjs', content: 'process.exit(3);\n' },
  ]);
  const failed = await startService({ worker, workspace, service: { start: ['node', 'server.mjs'], prepare: ['node', 'build.mjs'] } });
  expect(failed.ok).toBe(false);
  if (!failed.ok) expect(failed.error).toContain('PREPARE_FAILED');

  const works = await startService({ worker, workspace, service: { start: ['node', 'server.mjs'], prepare: ['node', '-e', 'process.exit(0)'] } });
  expect(works.ok, works.ok ? '' : works.error).toBe(true);
  if (works.ok) await works.running.stop();
});

it('says what is wrong instead of throwing when the service will not run', async () => {
  const worker = new LocalWorker();
  const workspace = await open(worker, [{ path: 'dies.mjs', content: 'process.exit(7);\n' }]);
  const noCommand = await startService({ worker, workspace, service: { start: [] } });
  expect(!noCommand.ok && noCommand.error).toContain('NO_START_COMMAND');

  const disallowed = await startService({ worker, workspace, service: { start: ['powershell', '-c', 'echo hi'] } });
  expect(!disallowed.ok && disallowed.error).toContain('PROGRAM_NOT_ALLOWED');

  // A service that exits is a finding about the deliverable, and the exit code is evidence.
  const died = await startService({ worker, workspace, service: { start: ['node', 'dies.mjs'] } });
  expect(!died.ok && died.error).toContain('SERVICE_EXITED');
  expect(!died.ok && died.error).toContain('7');

  // An allowed toolchain that is not installed arrives as an 'error' event rather than an exit
  // code, and an unhandled one would take the whole platform process down.
  const missing = await startService({ worker, workspace, service: { start: ['/nonexistent/uv', 'run', 'server.py'] } });
  expect(!missing.ok && missing.error).toContain('SERVICE_FAILED_TO_START');
});

it('never picks a port something else is already on', async () => {
  const first = await freePort();
  const second = await freePort();
  expect(second).not.toBe(first);
  expect(first).toBeGreaterThan(0);
});

it('stops a service spawned through a launcher, including its child', async () => {
  const worker = new LocalWorker();
  const workspace = await open(worker, [
    { path: 'server.mjs', content: serving },
    { path: 'launcher.mjs', content: 'import {spawn} from "node:child_process"; spawn(process.execPath,["server.mjs"],{stdio:"inherit"});' },
  ]);
  const started = await startService({ worker, workspace, service: { start: ['node', 'launcher.mjs'] } });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  try { expect(await reachable(started.running.port)).toBe(true); }
  finally { await started.running.stop(); }
  expect(await reachable(started.running.port)).toBe(false);
});
