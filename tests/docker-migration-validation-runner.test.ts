import {expect,it} from 'vitest';
import {DockerMigrationValidationRunner} from '../src/migration/infrastructure/docker-migration-validation-runner.js';
import type {SkillAssetRecord} from '../src/shared/contracts/skill-asset.js';
import {archiveOf,toolFixture} from './analysis-fixture.js';

const dockerTests=process.env.RUN_DOCKER_MIGRATION_SANDBOX_TESTS==='1';
const asset:SkillAssetRecord={schemaVersion:'finance.skill-eval.skill-asset.v1',assetId:'asset-sandbox',skillId:'sandbox-fixture',version:'1.0.0',
  displayName:'Sandbox fixture',description:'Controlled execution fixture',sourceType:'uploaded',artifactSha256:'a'.repeat(64),skillFile:'SKILL.md',fileCount:2,createdAt:'2026-10-12T00:00:00.000Z'};

it.runIf(dockerTests)('runs a packaged Python script without network access and confirms disposal',async()=>{
  const runner=new DockerMigrationValidationRunner(process.env.FINANCE_EVAL_MIGRATION_SANDBOX_IMAGE!);
  const archive=archiveOf({'SKILL.md':'fixture','scripts/check.py':[
    'import json, socket, sys',
    'request=json.load(sys.stdin)',
    'blocked=False',
    'try: socket.create_connection(("1.1.1.1", 53), timeout=0.2)',
    'except OSError: blocked=True',
    'print(json.dumps({"value": request["value"], "networkBlocked": blocked}))',
  ].join('\n')});
  const result=await runner.validateScript({asset,archive,request:{value:'ok'},tool:toolFixture({name:'check',sourcePaths:['scripts/check.py'],kind:'SCRIPT',portability:'PORTABLE_SCRIPT',entrypoint:{kind:'PYTHON',path:'scripts/check.py'}})});
  expect(result.status,result.error??'').toBe('PASSED');
  expect(result.mode).toBe('SANDBOXED');
  expect(result.stages).toContainEqual(expect.objectContaining({name:'SANDBOX_DISPOSED',passed:true}));
});

it.runIf(dockerTests)('runs a packaged FastMCP tool and confirms container and network disposal',async()=>{
  const runner=new DockerMigrationValidationRunner(process.env.FINANCE_EVAL_MIGRATION_SANDBOX_IMAGE!);
  const archive=archiveOf({'SKILL.md':'fixture','mcp/server.py':[
    'import os',
    'from fastmcp import FastMCP',
    'mcp=FastMCP("sandbox")',
    '@mcp.tool',
    'def lookup(value: str) -> dict:',
    '    return {"value": value}',
    'if __name__ == "__main__":',
    '    mcp.run(transport="http", host="0.0.0.0", port=int(os.environ["PORT"]))',
  ].join('\n')});
  const result=await runner.validateMcp({asset,archive,service:{start:['python3','mcp/server.py']},arguments:{value:'ok'},tool:toolFixture({name:'lookup',sourcePaths:['mcp/server.py'],kind:'MCP',portability:'PORTABLE_MCP',recommendedForm:'MCP'})});
  expect(result.status,result.error??'').toBe('PASSED');
  expect(result.stages).toContainEqual(expect.objectContaining({name:'TOOLS_CALL',passed:true}));
  expect(result.stages).toContainEqual(expect.objectContaining({name:'SANDBOX_DISPOSED',passed:true}));
});
