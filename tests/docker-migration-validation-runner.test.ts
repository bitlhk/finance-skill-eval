import {expect,it} from 'vitest';
import {DockerMigrationValidationRunner} from '../src/migration/infrastructure/docker-migration-validation-runner.js';
import type {SkillAssetRecord} from '../src/shared/contracts/skill-asset.js';
import {archiveOf,toolFixture} from './analysis-fixture.js';
import {PROCUREMENT_TEST_SERVICE} from '../src/migration/infrastructure/managed-migration-test-service.js';

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

it.runIf(dockerTests)('calls the pinned procurement service inside the isolated network and disposes both containers',async()=>{
  const runner=new DockerMigrationValidationRunner(process.env.FINANCE_EVAL_MIGRATION_SANDBOX_IMAGE!);
  const archive=archiveOf({'SKILL.md':'fixture','mcp/server.py':[
    'import json, os',
    'from urllib.request import Request, urlopen',
    'from fastmcp import FastMCP',
    'from fastmcp.server.dependencies import get_http_headers',
    'mcp=FastMCP("procurement")',
    '@mcp.tool',
    'def get_request(request_id: str) -> dict:',
    '    auth=get_http_headers(include_all=True).get("authorization")',
    '    request=Request(os.environ["BUSINESS_SERVICE_URL"]+"/business/request", data=json.dumps({"request_id":request_id}).encode(), headers={"Content-Type":"application/json","Authorization":auth})',
    '    with urlopen(request, timeout=5) as response: return json.load(response)',
    'if __name__ == "__main__":',
    '    mcp.run(transport="http", host="0.0.0.0", port=int(os.environ["PORT"]), path="/mcp", stateless_http=True)',
  ].join('\n')});
  const result=await runner.validateMcp({asset,archive,service:{start:['python3','mcp/server.py']},arguments:{request_id:'PO-001'},
    headers:{Authorization:'Bearer synthetic-procurement-e2e'},environment:{BUSINESS_SERVICE_URL:PROCUREMENT_TEST_SERVICE},
    tool:toolFixture({name:'get_request',sourcePaths:['mcp/server.py'],kind:'MCP',portability:'PORTABLE_MCP',recommendedForm:'MCP'})});
  expect(result.status,result.error??'').toBe('PASSED');
  expect(result.stages).toContainEqual(expect.objectContaining({name:'MANAGED_TEST_SERVICE',passed:true}));
  expect(result.stages).toContainEqual(expect.objectContaining({name:'TOOLS_CALL',passed:true}));
  expect(result.stages).toContainEqual(expect.objectContaining({name:'SANDBOX_DISPOSED',passed:true}));
});
