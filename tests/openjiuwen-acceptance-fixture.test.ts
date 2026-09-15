import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { manualPreparationSchema } from '../src/service/contracts.js';
import { validateSkill } from '../src/service/skill-validator.js';
import { loadEvalPack } from '../src/eval-pack.js';

const root=path.resolve('acceptance/openjiuwen-portability');

/** Read a fixture package the way an upload would arrive: flat, package-relative paths. */
async function readFixture(directory:string):Promise<Record<string,string>>{
  const files:Record<string,string>={};
  for(const name of await readdir(directory,{recursive:true})){
    const source=await readFile(path.join(directory,name),'utf8').catch(()=>null);
    if(source!==null)files[name.replaceAll('\\','/')]=source;
  }
  return files;
}

describe('deterministic OpenJiuwen acceptance fixture',()=>{
  it('is a valid frozen suite with disjoint development and holdout cases',async()=>{
    const suite=manualPreparationSchema.parse(JSON.parse(await readFile(path.join(root,'suite.json'),'utf8')));
    expect(suite.cases.map(item=>item.caseId)).toEqual(['PORTABILITY-HAPPY-001','PORTABILITY-MISSING-001','PORTABILITY-REJECTED-001','PORTABILITY-TOOL-ERROR-001']);
    expect(suite.holdoutCases.map(item=>item.caseId)).toEqual(['PORTABILITY-HOLDOUT-002']);
  });

  it('loads four public acceptance cases covering success and safe failures',async()=>{
    const pack=await loadEvalPack(path.resolve('packs/finance/openjiuwen-portability-acceptance/eval.yaml'));
    expect(pack.cases.map(item=>item.caseId)).toEqual(['PORTABILITY-HAPPY-001','PORTABILITY-MISSING-001','PORTABILITY-REJECTED-001','PORTABILITY-TOOL-ERROR-001']);
    expect(pack.cases.filter(item=>item.requiredTools.includes('calculate_acceptance_total'))).toHaveLength(2);
  });

  // These fixtures are inputs to the acceptance run. What is checkable here without a model is
  // that they are well-formed Skills; *which* Tools they contain is the analysis's reading, and
  // is exercised by the acceptance run itself rather than asserted here as a rule's guess.
  it('is a compliant Skill with one portable MCP and one portable Script Tool',async()=>{
    const files=await readFixture(path.join(root,'skill'));
    expect(validateSkill(files,'SKILL.md').status).toBe('COMPLIANT');
    expect(Object.keys(files).some(name=>name.startsWith('scripts/'))).toBe(true);
  });

  it('provides a legacy source with the same two tools bound to an Agent Runtime',async()=>{
    const files=await readFixture(path.join(root,'legacy-skill'));
    expect(validateSkill(files,'SKILL.md').status).toBe('COMPLIANT');
    expect(Object.keys(files)).toContain('legacy_runtime_tools.py');
  });

  it('provides a Script-only Skill with a project-defined Python environment',async()=>{
    const files=await readFixture(path.join(root,'script-only-skill'));
    expect(validateSkill(files,'SKILL.md').status).toBe('COMPLIANT');
    expect(files['scripts/pyproject.toml']).toContain('requires-python = ">=3.11"');
  });

  it('provides two Tools from one shared MCP service',async()=>{
    const files=await readFixture(path.join(root,'shared-mcp-skill'));
    expect(validateSkill(files,'SKILL.md').status).toBe('COMPLIANT');
    expect(Object.keys(files)).toContain('mcp/server.py');
  });
});
