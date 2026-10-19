import { args, settings, preflight } from './lib/settings.mjs';
try {
  const options = args();
  console.log(JSON.stringify(await preflight(await settings(options.env), { component: options.component || 'all', ports: options.ports === true })));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAILED', code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'PREFLIGHT_FAILED_CHECK_CONFIG_AND_FILES' }));
  process.exitCode = 1;
}
