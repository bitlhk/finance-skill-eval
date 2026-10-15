import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import path from 'node:path';
import {validateServiceEnvironment} from './service-environment.js';
import type { LocalWorker, LocalWorkerWorkspace } from './local-worker.js';

/**
 * Start a delivered service the way its own deliverable says to start it.
 *
 * The mirror of what the A4 agent does inside its own loop (`integrations/openjiuwen/migration_tools.py`
 * `_mcp_contract`), because the platform owes the same check the agent does: if the platform only
 * ever connects to an endpoint an operator typed in, then nothing has ever verified that the
 * service it delivered can start. The delivered `start` argv is what it is started with; `prepare`
 * is the optional one-shot before it (install, build).
 *
 * This is the same trust position as running a migrated Script: enterprise code, on the
 * workstation, argv only (never a shell string), with the result labelled LOCAL_TRUSTED.
 */

export type ServiceStart = { program: string; args: string[]; directory: string };
export type RunningService = { endpoint: string; port: number; stop(): Promise<void>; stderr(): string };

const READY_TIMEOUT_MS = 120_000;
const PREPARE_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 20_000;

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') { probe.close(); reject(new Error('no port')); return; }
      const { port } = address;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForPort(port: number, timeoutMs: number, alive: () => string | null): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exit = alive();
    if (exit) throw new Error(exit);
    const open = await new Promise<boolean>(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
    if (open) return true;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return false;
}

/**
 * Stop the service *and everything it spawned*.
 *
 * Killing the launcher alone is not enough: `uv run` and `npm` start a child that inherits the
 * pipes and keeps the port, so waiting on the parent would hang on a process waiting for its own
 * child. Same reason the agent-side tool uses a tree kill.
 */
export async function terminate(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const alreadyExited=child.exitCode!==null||child.signalCode!==null;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide:true });
      killer.once('close', code => {if(code!==0&&child.exitCode===null)child.kill('SIGKILL');resolve();});
      killer.once('error', () => {if(child.exitCode===null)child.kill('SIGKILL');resolve();});
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  if(alreadyExited)return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([closed, new Promise<void>(resolve => { timer=setTimeout(resolve, STOP_TIMEOUT_MS); })]);
    if(child.exitCode===null&&child.signalCode===null)throw new Error('SERVICE_STOP_TIMEOUT: 服务进程尚未确认退出');
  } finally { clearTimeout(timer); }
}

function runToCompletion(command: { program: string; args: string[] }, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(command.program, command.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const finish = (result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }) => {
      if (settled) return; settled = true; clearTimeout(timer); resolve(result);
    };
    const timer = setTimeout(() => { timedOut = true; void terminate(child).then(() => finish({ exitCode: null, stdout, stderr, timedOut: true })); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-16_384); });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once('close', code => finish({ exitCode: code, stdout, stderr, timedOut }));
  });
}

/** What a service needs to be started, straight out of the deliverable. */
export type Launchable = { start?: string[]; prepare?: string[] };

/**
 * Prepare then start, and hand back an endpoint that is ready to be spoken to.
 *
 * Returns a sentence rather than throwing for the failures that are *results* -- a service that
 * will not start is a finding about the deliverable, not an error in the platform.
 */
export async function startService(input: {
  worker: LocalWorker;
  workspace: LocalWorkerWorkspace;
  service: Launchable;
  environment?: Record<string,string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ ok: true; running: RunningService } | { ok: false; error: string }> {
  const start = (input.service.start ?? []).map(String).filter(Boolean);
  if (!start.length) return { ok: false, error: 'NO_START_COMMAND: 交付物没有声明启动命令，平台不知道该怎么起它' };
  const prepare = (input.service.prepare ?? []).map(String).filter(Boolean);
  for (const argv of [start, prepare]) {
    if (!argv.length) continue;
    try { input.worker.assertServiceProgram(argv[0]!); }
    catch (error) { return { ok: false, error: `PROGRAM_NOT_ALLOWED: ${error instanceof Error ? error.message : String(error)}` }; }
  }

  const port = await freePort();
  const environment=validateServiceEnvironment(input.environment??{});
  const protect=(message:string)=>Object.keys(environment).length?'MCP 服务启动失败，请检查服务配置与实现。原始错误未保留以保护配置值。':message;
  const env = { ...process.env, ...environment, PORT: String(port), PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' };
  const directory = input.workspace.directory;

  if (prepare.length) {
    let prepared: Awaited<ReturnType<typeof runToCompletion>>;
    try { prepared = await runToCompletion({ program: prepare[0]!, args: prepare.slice(1) }, directory, { ...process.env, PORT:String(port), PYTHONUTF8:'1', PYTHONUNBUFFERED:'1' }, PREPARE_TIMEOUT_MS); }
    catch (error) { return { ok: false, error: `PREPARE_FAILED: ${error instanceof Error ? error.message : String(error)}` }; }
    if (prepared.exitCode !== 0) return { ok: false, error: `PREPARE_FAILED: ${(prepared.stderr || prepared.stdout || `exit ${prepared.exitCode}`).trim().slice(0, 1200)}` };
  }

  const child = spawn(start[0]!, start.slice(1), { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  let stderr = '', spawnError: string | null = null;
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
  child.stdout?.on('data', () => undefined);
  // A command that cannot be executed at all -- the toolchain is missing -- arrives as an event,
  // not as an exit code, and an unhandled one would take the process down with it.
  child.once('error', error => { spawnError = `SERVICE_FAILED_TO_START: 启动命令 ${start.join(' ')} 无法执行：${error.message}`; });
  const abort = () => { void terminate(child); };
  input.signal?.addEventListener('abort', abort, { once: true });
  // Same lost-cancel window as the one-shot worker: the signal may have fired while `prepare` was
  // running, and waiting for it to fire again means holding a service nobody wants.
  if (input.signal?.aborted) abort();

  const alive = (): string | null => spawnError ?? (child.exitCode === null
    ? null
    : protect(`SERVICE_EXITED: 启动命令 ${start.join(' ')} 以退出码 ${child.exitCode} 结束${stderr.trim() ? `：${stderr.trim().slice(-600)}` : ''}`));

  try {
    const ready = await waitForPort(port, input.timeoutMs ?? READY_TIMEOUT_MS, alive);
    if (!ready) {await terminate(child);input.signal?.removeEventListener('abort',abort);return {
      ok: false,
      error: protect(`SERVICE_DID_NOT_START: 启动命令 ${start.join(' ')} 在 ${Math.round((input.timeoutMs ?? READY_TIMEOUT_MS) / 1000)}s 内没有监听 PORT=${port}${stderr.trim() ? `：${stderr.trim().slice(-600)}` : ''}`),
    };}
  } catch (error) {
    await terminate(child);
    input.signal?.removeEventListener('abort',abort);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  // The endpoint is the platform's own convention, and the deliverable is told about it.
  return { ok: true, running: { endpoint: `http://127.0.0.1:${port}/mcp`, port, stop: async () => {input.signal?.removeEventListener('abort',abort);await terminate(child);}, stderr: () => Object.keys(environment).length?'':stderr } };
}

/** Resolve the service directory a delivered `start` should run in, if the files imply one. */
export function serviceDirectoryOf(entrypoint: string | undefined): string {
  if (!entrypoint) return '.';
  const directory = path.posix.dirname(entrypoint.replaceAll('\\', '/'));
  return directory === '.' ? '.' : directory;
}
