import { args, settings, fail } from './lib/settings.mjs';
import { runtimeLauncherCapabilitiesSchema } from '../dist/shared/contracts/runtime-launcher.js';
const options = args();
try {
  const { env } = await settings(options.env);
  const api = options.api || `http://127.0.0.1:${env.FINANCE_EVAL_PORT}`;
  const runtime = options.runtime || `http://127.0.0.1:${env.FINANCE_RUNTIME_PORT}`;
  const get = async (url, headers) => fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  const response = await get(api + '/api/health');
  if (!response.ok || (await response.json()).status !== 'ready') fail('API_NOT_READY');
  if ((await get(api + '/api/migration-tasks')).status !== 401) fail('ANONYMOUS_ACCESS_NOT_BLOCKED');
  if (!(await get(api + '/api/migration-tasks', { authorization: 'Bearer ' + env.FINANCE_EVAL_ACCESS_TOKEN })).ok) fail('AUTHENTICATED_WORKSPACE_NOT_READY');
  if (!(await get(api + '/api/catalog', { authorization: 'Bearer ' + env.FINANCE_EVAL_ACCESS_TOKEN })).ok) fail('WORKSPACE_CATALOG_NOT_READY');
  const capabilities = await get(runtime + '/v1/runtime-capabilities');
  if (!capabilities.ok) fail('MULTI_SKILL_RUNTIME_NOT_READY');
  const parsed = runtimeLauncherCapabilitiesSchema.safeParse(await capabilities.json());
  if (!parsed.success || parsed.data.limits.maxSkills < 2) fail('MULTI_SKILL_RUNTIME_NOT_READY');
  console.log(JSON.stringify({ status: 'PASSED', checks: ['api', 'authentication', 'workspace-catalog', 'multi-skill-runtime'], modelExecution: 'NOT_TESTED' }));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAILED', code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'HEALTH_CONNECTION_FAILED' }));
  process.exitCode = 1;
}
