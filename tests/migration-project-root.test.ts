import {afterEach,expect,it,vi} from 'vitest';
import * as runner from '../src/migration/infrastructure/migration-agent-runner.js';

afterEach(()=>vi.unstubAllEnvs());

it('separates operator-pinned migration code from the catalog asset root',()=>{
  vi.stubEnv('FINANCE_EVAL_ROOT','/release/catalog');
  vi.stubEnv('FINANCE_EVAL_MIGRATION_PROJECT_ROOT','/release/eval');
  expect(runner.migrationProjectRoot()).toBe('/release/eval');
});

it('retains the legacy project root when no separate code root is configured',()=>{
  vi.stubEnv('FINANCE_EVAL_ROOT','/legacy/project');
  vi.stubEnv('FINANCE_EVAL_MIGRATION_PROJECT_ROOT','');
  expect(runner.migrationProjectRoot()).toBe('/legacy/project');
});

it('rejects a relative deployment code override',()=>{
  vi.stubEnv('FINANCE_EVAL_MIGRATION_PROJECT_ROOT','../uploaded');
  expect(()=>runner.migrationProjectRoot()).toThrow('MIGRATION_PROJECT_ROOT_MUST_BE_ABSOLUTE');
});

it('reports missing installed entry before starting a subprocess',async()=>{
  vi.stubEnv('FINANCE_EVAL_MIGRATION_PYTHON',process.execPath);
  vi.stubEnv('FINANCE_RUNTIME_CONFIG',new URL('../package.json',import.meta.url).pathname);
  const result=await runner.runMigrationAgent('A2',{assetDigest:'a'.repeat(64)},
    {projectRoot:'/missing-eval-code',modelId:'not-called'});
  expect(result.status).toBe('FAILED');
  expect(result.run.error).toBe('MIGRATION_AGENT_ENTRY_MISSING: check the installed migration code directory');
});
