import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect,it } from 'vitest';

const root=process.cwd();
const agents=['analyze_agent.py','migrate_agent.py'] as const;
const source=async(file:string)=>await readFile(path.join(root,'integrations','openjiuwen',file),'utf8');

it('aligns A4 generation and its delivery skill on model versus encapsulated tool responsibilities',async()=>{
 const code=await source('migrate_agent.py');
 const prompt=code.match(/SYSTEM_PROMPT = """([\s\S]*?)"""/)?.[1];
 expect(prompt).toBeDefined();
 const delivery=await readFile(path.join(root,'skills','enterprise-migration-delivery','SKILL.md'),'utf8');
 for(const text of [prompt!,delivery]){
  expect(text).toContain('HTTP 请求顺序、鉴权');
  expect(text).toContain('工具工程 README 或配置模板');
  expect(text).toContain('资源读取方式');
  expect(text).toContain('不依据示例补字符');
  expect(text).toContain('不改变工具 Schema');
 }
 expect(prompt).toContain('模型确实负责多工具协调');
 expect(prompt).toContain('模型要重复执行的步骤');
 expect(delivery).toContain('不展开成模型的执行步骤');
 expect(prompt).toContain('不会用关键词过滤');
 expect(delivery).toContain('不按标题、HTTP 或公式等关键词机械删除');
});

/**
 * Which tools the two agents are handed, read off their source.
 *
 * `grep` is the one that had to be written here. The harness's `GrepTool` builds a command line
 * and shells out with it; on this platform that command is a PowerShell pipeline script, the
 * allowlist gate reads only its first token, and every call comes back as "shell operation
 * execution error" -- which reads to the agent as "this package has no matches". Swapping the
 * import back would restore that silently, so it is asserted rather than remembered.
 */
it('gives both agents our grep, which reads the files instead of shelling out',async()=>{
  for(const agent of agents){
    const code=await source(agent);
    expect(code,`${agent} builds our grep`).toContain('build_grep_tool(workspace,');
    expect(code,`${agent} no longer imports the harness's GrepTool`).not.toMatch(/\bGrepTool\b/);
  }
});

// The other half of the same boundary: no shell tool is registered by hand either. A shell can
// write, and A2 is supposed to be read-only. Only the harness import is read, so the comment
// explaining the omission is not itself a failure.
it('hands neither agent a shell tool',async()=>{
  for(const agent of agents){
    const code=await source(agent);
    const imported=agent==='analyze_agent.py'
      ?code.match(/from analysis_file_tools import[^\n]*/)?.[0]??''
      :code.match(/from openjiuwen\.harness\.tools import[\s\S]*?\)/)?.[0]??'';
    expect(imported,`${agent} has an explicit file tool list`).not.toBe('');
    for(const tool of ['BashTool','PowerShellTool','CodeTool','TerminalTool']){
      expect(imported,`${agent} does not import ${tool}`).not.toContain(tool);
    }
  }
});

it('binds every general A2 file tool to the per-request workspace',async()=>{
  const code=await source('analyze_agent.py');
  for(const name of ['WorkspaceReadFileTool','WorkspaceGlobTool','WorkspaceListDirTool'])
    expect(code).toContain(`${name}(workspace, sys_op, lang, agent_id`);
  expect(code).not.toContain('from openjiuwen.harness.tools import');
});
