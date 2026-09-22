import { describe, expect, it } from 'vitest';
import { buildMigrationPlan, recommendLanguage, unmigratableLanguages, type ProjectInspection, type ToolDecision, type ToolInspection } from '../src/service/migration-model.js';
import { inspectionFixture, toolFixture } from './analysis-fixture.js';

const tool=(overrides:Partial<ToolInspection>):ToolInspection=>({
  toolId:'data_tool-00000000',name:'data_tool',sourcePaths:['tool/DataTool.java'],language:'Java',kind:'RUNTIME_BOUND',portability:'RUNTIME_BOUND',
  inputSchema:null,outputSchema:null,evidence:[],findings:[],
  recommendedForm:'MCP',recommendedLanguage:'java',recommendationReason:'test',...overrides});

const inspection=(tools:ToolInspection[]):ProjectInspection=>({
  assetId:'asset',assetDigest:'a'.repeat(64),inspectedAt:new Date().toISOString(),scriptsExecuted:false,
  skill:{status:'COMPLIANT',findings:[]},tools});

const decision=(toolId:string,form:'MCP'|'SCRIPT',language?:string):ToolDecision=>
  ({toolId,form,reason:'test',baseAssetId:'asset',decidedAt:new Date().toISOString(),...(language?{language}:{})});

describe('recommendLanguage',()=>{
  it('keeps the source language when the form can express it',()=>{
    expect(recommendLanguage('MCP','Java')).toBe('java');
    expect(recommendLanguage('MCP','Python')).toBe('python');
    expect(recommendLanguage('MCP','JavaScript')).toBe('node');
    expect(recommendLanguage('SCRIPT','Python')).toBe('python');
    expect(recommendLanguage('SCRIPT','JavaScript')).toBe('node');
  });
  it('falls back by form when the source language is not a target of that form',()=>{
    // Java has no Script runtime here, so a Java source asked to be a script is a rewrite.
    expect(recommendLanguage('SCRIPT','Java')).toBe('python');
    expect(recommendLanguage('MCP','Go')).toBe('java');
    expect(recommendLanguage('SCRIPT','Rust')).toBe('python');
  });
  it('defaults on an undetermined source language',()=>{
    expect(recommendLanguage('MCP',null)).toBe('java');
    expect(recommendLanguage('SCRIPT',null)).toBe('python');
  });
  it('accepts a source that spans several languages, choosing the one the form can keep',()=>{
    expect(recommendLanguage('MCP','Java, Python')).toBe('java');
    expect(recommendLanguage('SCRIPT','Java, JavaScript')).toBe('node');
  });
});

describe('unmigratableLanguages',()=>{
  it('names only the languages outside the supported set',()=>{
    expect(unmigratableLanguages('Java')).toEqual([]);
    expect(unmigratableLanguages('Python, JavaScript')).toEqual([]);
    expect(unmigratableLanguages('Go')).toEqual(['Go']);
    expect(unmigratableLanguages('Java, Go')).toEqual(['Go']);
    expect(unmigratableLanguages(null)).toEqual([]);
  });
});

describe('buildMigrationPlan language decisions',()=>{
  it('warns instead of blocking when a human override forces a rewrite',()=>{
    const plan=buildMigrationPlan(inspection([tool({})]),[decision('data_tool-00000000','SCRIPT')],'asset');
    const item=plan.items[0]!;
    expect(item.language).toBe('python');
    expect(item.blockingReasons).toEqual([]);
    expect(item.warnings.join()).toContain('跨语言重写');
    expect(plan.generationAllowed).toBe(true);
  });
  it('stays silent when the override keeps the source language',()=>{
    const plan=buildMigrationPlan(inspection([tool({sourcePaths:['scripts/data_tool.py'],language:'Python'})]),[decision('data_tool-00000000','SCRIPT')],'asset');
    expect(plan.items[0]!.language).toBe('python');
    expect(plan.items[0]!.warnings).toEqual([]);
  });
  it('derives the language from the chosen form, not from the platform recommendation',()=>{
    // The platform recommends MCP/java; the human switched the form and named no language.
    const plan=buildMigrationPlan(inspection([tool({})]),[decision('data_tool-00000000','SCRIPT')],'asset');
    expect(plan.items[0]!.language).not.toBe('java');
  });
  it('blocks a source language the platform cannot migrate',()=>{
    const plan=buildMigrationPlan(inspection([tool({sourcePaths:['tool/data_tool.go'],language:'Go'})]),[decision('data_tool-00000000','MCP')],'asset');
    expect(plan.items[0]!.blockingReasons.join()).toContain('Go');
    expect(plan.generationAllowed).toBe(false);
  });
  it('blocks nothing when no tool needs migrating',()=>{
    const plan=buildMigrationPlan(inspection([]),[],'asset');
    expect(plan.items).toEqual([]);
    expect(plan.generationAllowed).toBe(true);
  });
});

it('refuses to auto-migrate a source language outside the supported set',()=>{
  // The analysis reports the language and the portability; the plan is what refuses. Marking a
  // Tool UNSUPPORTED by rule is gone with the rest of the rules-side Tool guessing.
  const go=toolFixture({name:'data_tool',sourcePaths:['scripts/data_tool.go'],language:'Go',portability:'UNSUPPORTED'});
  const plan=buildMigrationPlan(inspectionFixture([go]),[decision(go.toolId,'MCP')],'asset');
  expect(plan.items[0]!.blockingReasons.join()).toContain('Go');
  expect(plan.generationAllowed).toBe(false);
});
