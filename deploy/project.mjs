// Shared project paths and offline backup; configuration is data, never shell input.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { args, settings, fail } from './lib/settings.mjs';
try {
  const options = args(), command = options._?.[0];
  const { env, root, python, file } = await settings(options.env);
  if (command === 'paths') {
    console.log(JSON.stringify({ root, env: file, data: env.FINANCE_EVAL_DATA_DIR, runtime: env.FINANCE_RUNTIME_CONFIG, python }));
  } else if (command === 'backup' || command === 'restore') {
    if (!options.archive || !path.isAbsolute(options.archive)) fail('ABSOLUTE_ARCHIVE_PATH_REQUIRED');
    const parameters = [path.join(root, 'deploy/backup.py'), command === 'backup' ? 'create' : 'restore', '--archive', options.archive];
    if (command === 'backup') parameters.push('--data', env.FINANCE_EVAL_DATA_DIR, '--config-file', file, '--config-file', env.FINANCE_RUNTIME_CONFIG);
    else {
      if (!options.destination || !path.isAbsolute(options.destination)) fail('ABSOLUTE_DESTINATION_REQUIRED');
      parameters.push('--destination', options.destination);
    }
    const result = spawnSync(python, parameters, { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    if (result.error || result.status !== 0) fail('BACKUP_OPERATION_FAILED');
  } else fail('USAGE_PROJECT_PATHS_BACKUP_RESTORE');
} catch (error) {
  console.error(/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'PROJECT_CONFIGURATION_FAILED');
  process.exitCode = 1;
}
