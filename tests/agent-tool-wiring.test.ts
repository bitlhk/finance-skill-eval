import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect,it } from 'vitest';

const root=process.cwd();
const agents=['analyze_agent.py','migrate_agent.py'] as const;
const source=async(file:string)=>await readFile(path.join(root,'integrations','openjiuwen',file),'utf8');

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
    const imported=(await source(agent)).match(/from openjiuwen\.harness\.tools import[\s\S]*?\)/)?.[0]??'';
    expect(imported,`${agent} imports tools from the harness`).toContain('from openjiuwen.harness.tools import');
    for(const tool of ['BashTool','PowerShellTool','CodeTool','TerminalTool']){
      expect(imported,`${agent} does not import ${tool}`).not.toContain(tool);
    }
  }
});
