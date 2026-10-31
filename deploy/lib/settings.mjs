import { readFile, mkdir, access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const fail = code => { throw new Error(code); };
export function args(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) (options._ ??= []).push(argv[i]);
    else {
      const key = argv[i].slice(2);
      options[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return options;
}
export async function settings(file, inherited = process.env, root = projectRoot) {
  const configFile = path.resolve(root, file || '.env.local');
  const values = parseEnv(await readFile(configFile, 'utf8'));
  const env = { ...inherited, ...values, NODE_ENV: 'production', FINANCE_EVAL_ROOT: root,
    FINANCE_EVAL_MIGRATION_PROJECT_ROOT: root, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' };
  const python = env.FINANCE_EVAL_MIGRATION_PYTHON || path.join(root, '.venv-openjiuwen', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  env.FINANCE_EVAL_MIGRATION_PYTHON = python;
  env.FINANCE_EVAL_DATA_DIR = path.resolve(root, env.FINANCE_EVAL_DATA_DIR || 'data');
  env.FINANCE_RUNTIME_CONFIG = path.resolve(root, env.FINANCE_RUNTIME_CONFIG || '.runtime.local.json');
  env.FINANCE_EVAL_MIGRATION_AGENT = 'on';
  env.FINANCE_EVAL_HOST ||= '127.0.0.1';
  env.FINANCE_EVAL_PORT ||= '56361';
  env.FINANCE_RUNTIME_HOST ||= '127.0.0.1';
  env.FINANCE_RUNTIME_PORT ||= '56362';
  env.PATH = [path.dirname(python), path.dirname(process.execPath), env.PATH || env.Path || ''].join(path.delimiter);
  if (process.platform === 'win32') delete env.Path;
  return { env, root, python, file: configFile };
}
export function validateValues(env, component = 'all') {
  const required = name => {
    const value = env[name];
    if (typeof value !== 'string' || !value.trim() || /REPLACE_WITH|CHANGEME/.test(value)) fail('REQUIRED_' + name);
    return value;
  };
  for (const key of ['FINANCE_EVAL_DATA_DIR', 'FINANCE_RUNTIME_CONFIG', 'FINANCE_EVAL_MIGRATION_PYTHON'])
    if (!path.isAbsolute(required(key))) fail('ABSOLUTE_PATH_REQUIRED_' + key);
  for (const key of ['FINANCE_EVAL_PORT', 'FINANCE_RUNTIME_PORT']) {
    if (!/^\d+$/.test(env[key]) || Number(env[key]) < 1024 || Number(env[key]) > 65535) fail('INVALID_' + key);
  }
  if (Number(env.FINANCE_EVAL_PORT) === Number(env.FINANCE_RUNTIME_PORT)) fail('API_RUNTIME_PORT_CONFLICT');
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(env.FINANCE_EVAL_LOG_LEVEL || 'info')) fail('INVALID_LOG_LEVEL');
  const concurrency = Number(env.FINANCE_EVAL_MAX_CONCURRENT_RUNS || 1);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) fail('INVALID_MAX_CONCURRENT_RUNS');
  if (component !== 'runtime') {
    if (required('FINANCE_EVAL_ACCESS_TOKEN').length < 32) fail('ACCESS_TOKEN_MINIMUM_32_CHARACTERS');
    const key = env.FINANCE_EVAL_JUDGE_API_KEY || env.FINANCE_EVAL_MODEL_API_KEY;
    const base = env.FINANCE_EVAL_JUDGE_BASE_URL || env.FINANCE_EVAL_MODEL_BASE_URL;
    const model = env.FINANCE_EVAL_JUDGE_MODEL || env.FINANCE_EVAL_MODEL;
    if (![key, base, model].every(v => v && !/REPLACE_WITH|CHANGEME/.test(v))) fail('JUDGE_CONFIGURATION_REQUIRED');
    validUrl(base);
  }
  if (env.FINANCE_EVAL_AGENT_DUMP) fail('DISABLE_AGENT_DUMP_FOR_DEFAULT_PRODUCTION_PROFILE');
  if (env.FINANCE_EVAL_PUBLIC_DEMO === 'true') fail('PRODUCTION_PROFILE_REQUIRES_PRIVATE_WORKSPACE');
}
export function validUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('INVALID_MODEL_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('INVALID_MODEL_URL');
}
export function validateRuntime(config, modelId) {
  const entries = Object.entries(config.models ?? {}).filter(([, m]) => m.enabled !== false);
  if (!entries.length) fail('RUNTIME_ENABLED_MODEL_REQUIRED');
  for (const [, model] of entries) {
    for (const field of ['apiKey', 'baseUrl', 'upstreamModelId'])
      if (typeof model[field] !== 'string' || !model[field].trim() || /REPLACE_WITH|CHANGEME/.test(model[field])) fail('RUNTIME_MODEL_FIELDS_INCOMPLETE');
    validUrl(model.baseUrl);
  }
  if (!entries.some(([id]) => id === (modelId || config.defaultModelId || 'enterprise-model'))) fail('MIGRATION_MODEL_NOT_REGISTERED');
}
export async function portAvailable(host, port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error('PORT_UNAVAILABLE_' + port)));
    server.listen(Number(port), host, () => server.close(resolve));
  });
}
export async function preflight(config, { component = 'all', ports = false } = {}) {
  const { env, root, python, file } = config;
  if (!['api', 'runtime', 'all'].includes(component)) fail('INVALID_COMPONENT');
  if (Number(process.versions.node.split('.')[0]) < 22) fail('NODE_22_OR_NEWER_REQUIRED');
  validateValues(env, component);
  validateRuntime(JSON.parse(await readFile(env.FINANCE_RUNTIME_CONFIG, 'utf8')), env.FINANCE_EVAL_AGENT_MODEL_ID);
  for (const item of [file, env.FINANCE_RUNTIME_CONFIG].filter(Boolean)) {
    const mode = (await stat(item)).mode;
    if (process.platform !== 'win32' && (mode & 0o007)) fail('CONFIG_MUST_NOT_BE_WORLD_ACCESSIBLE');
  }
  for (const item of ['integrations/openjiuwen/uv.lock', 'integrations/openjiuwen/serve.py',
    ...(component !== 'runtime' ? ['dist/service/server.js', 'web-dist/index.html'] : [])])
    await access(path.join(root, item), constants.R_OK).catch(() => fail('BUILD_OR_RUNTIME_FILES_MISSING'));
  await mkdir(env.FINANCE_EVAL_DATA_DIR, { recursive: true, mode: 0o700 });
  await access(env.FINANCE_EVAL_DATA_DIR, constants.W_OK).catch(() => fail('DATA_DIRECTORY_NOT_WRITABLE'));
  const { statfs } = await import('node:fs/promises');
  const disk = await statfs(env.FINANCE_EVAL_DATA_DIR);
  const minimum = Number(env.FINANCE_EVAL_MIN_FREE_MB || 1024);
  if (!Number.isFinite(minimum) || minimum < 128) fail('INVALID_MIN_FREE_MB');
  if (disk.bavail * disk.bsize < minimum * 1024 * 1024) fail('INSUFFICIENT_FREE_DISK');
  const probe = spawnSync(python, ['-c', 'import sys,tomllib; from importlib.metadata import version; assert (3,11)<=sys.version_info[:2]<(3,14); import openjiuwen,uvicorn,fastmcp,fastapi; deps=tomllib.load(open("integrations/openjiuwen/pyproject.toml","rb"))["project"]["dependencies"]; assert all(version(d.split("==")[0])==d.split("==")[1] for d in deps)'],
    { cwd: root, env, encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 });
  if (probe.error || probe.status !== 0) fail('PYTHON_311_313_OR_LOCKED_RUNTIME_DEPENDENCIES_MISSING');
  if (ports) {
    if (component !== 'runtime') await portAvailable(env.FINANCE_EVAL_HOST, env.FINANCE_EVAL_PORT);
    if (component !== 'api') await portAvailable(env.FINANCE_RUNTIME_HOST, env.FINANCE_RUNTIME_PORT);
  }
  return { status: 'PASSED', component, checks: ['configuration', 'build', 'python-imports-and-pinned-versions', 'writable-data', 'disk-space', ...(ports ? ['ports'] : [])],
    modelConnectivity: 'NOT_TESTED', windowsAcl: process.platform === 'win32' ? 'OPERATOR_MUST_VERIFY' : 'NOT_APPLICABLE' };
}
