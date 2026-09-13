import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { manualPreparationSchema } from '../src/service/contracts.js';
import { inspectProject } from '../src/service/tool-inspector.js';
import { loadEvalPack } from '../src/eval-pack.js';

const root=path.resolve('acceptance/openjiuwen-portability');

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

  it('is a compliant Skill with one portable MCP and one portable Script Tool',async()=>{
    const skillRoot=path.join(root,'skill'),files:Record<string,string>={};
    for(const name of await readdir(skillRoot,{recursive:true})){
      const absolute=path.join(skillRoot,name);
      const source=await readFile(absolute,'utf8').catch(()=>null);
      if(source!==null)files[name.replaceAll('\\','/')]=source;
    }
    const inspection=inspectProject({assetId:'acceptance-fixture',assetDigest:'a'.repeat(64),files,skillFile:'SKILL.md'});
    expect(inspection.skill.status).toBe('COMPLIANT');
    expect(inspection.tools.map(tool=>[tool.name,tool.portability])).toEqual([
      ['calculate_acceptance_total','PORTABLE_SCRIPT'],
      ['get_acceptance_order','PORTABLE_MCP'],
    ]);
  });

  it('provides a legacy source with the same two tools bound to an Agent Runtime',async()=>{
    const skillRoot=path.join(root,'legacy-skill'),files:Record<string,string>={};
    for(const name of await readdir(skillRoot,{recursive:true})){
      const source=await readFile(path.join(skillRoot,name),'utf8').catch(()=>null);
      if(source!==null)files[name.replaceAll('\\','/')]=source;
    }
    const inspection=inspectProject({assetId:'legacy-fixture',assetDigest:'b'.repeat(64),files,skillFile:'SKILL.md'});
    expect(inspection.skill.status).toBe('COMPLIANT');
    expect(inspection.tools.map(tool=>[tool.name,tool.portability])).toEqual([
      ['calculate_acceptance_total','RUNTIME_BOUND'],
      ['get_acceptance_order','RUNTIME_BOUND'],
    ]);
    expect(inspection.tools.every(tool=>tool.sourcePaths.includes('legacy_runtime_tools.py'))).toBe(true);
  });

  it('provides a Script-only Skill with a project-defined Python environment',async()=>{
    const skillRoot=path.join(root,'script-only-skill'),files:Record<string,string>={};
    for(const name of await readdir(skillRoot,{recursive:true})){
      const source=await readFile(path.join(skillRoot,name),'utf8').catch(()=>null);
      if(source!==null)files[name.replaceAll('\\','/')]=source;
    }
    const inspection=inspectProject({assetId:'script-only-fixture',assetDigest:'c'.repeat(64),files,skillFile:'SKILL.md'});
    expect(inspection.skill.status).toBe('COMPLIANT');
    expect(inspection.tools.map(tool=>[tool.name,tool.portability])).toEqual([['normalize_invoice','PORTABLE_SCRIPT']]);
    expect(files['scripts/pyproject.toml']).toContain('requires-python = ">=3.11"');
  });

  it('provides two Tools from one shared MCP service',async()=>{
    const skillRoot=path.join(root,'shared-mcp-skill'),files:Record<string,string>={};
    for(const name of await readdir(skillRoot,{recursive:true})){
      const source=await readFile(path.join(skillRoot,name),'utf8').catch(()=>null);
      if(source!==null)files[name.replaceAll('\\','/')]=source;
    }
    const inspection=inspectProject({assetId:'shared-mcp-fixture',assetDigest:'d'.repeat(64),files,skillFile:'SKILL.md'});
    expect(inspection.skill.status).toBe('COMPLIANT');
    expect(inspection.tools.map(tool=>[tool.name,tool.portability])).toEqual([
      ['get_acceptance_account','PORTABLE_MCP'],
      ['get_acceptance_customer','PORTABLE_MCP'],
    ]);
    expect(new Set(inspection.tools.flatMap(tool=>tool.sourcePaths))).toEqual(new Set(['mcp/server.py']));
  });
});
