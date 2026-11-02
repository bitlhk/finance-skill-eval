import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
import {loadAgentRole} from '../src/agents/composition.js';

it('gives diagnosis a read-only scanner and migration scoped compile and contract tools',()=>{
 const diagnosis=loadAgentRole('diagnosis'),migration=loadAgentRole('migration');
 expect(diagnosis.definition.tools).toContain('run_scanner');
 expect(diagnosis.definition.tools).not.toContain('write_file');
 expect(migration.definition.tools).toContain('compile_source');
 expect(migration.definition.conditionalTools).toContain('run_mcp_contract_suite');
 for(const role of [diagnosis,migration])expect(role.definition.tools).not.toContain('bash');
});
it('keeps the unified agent grep and file tools bound to its workspace',async()=>{
 const source=await readFile(new URL('../integrations/openjiuwen/bundle_agent.py',import.meta.url),'utf8');
 expect(source).toContain('build_grep_tool(workspace,');
 expect(source).not.toMatch(/\bGrepTool\b/);
 for(const tool of ['WorkspaceReadFileTool','WorkspaceGlobTool','WorkspaceListDirTool'])expect(source).toContain(tool+'(workspace, *args)');
 expect(source).toContain("build_run_scanner(workspace / 'source')");
});
