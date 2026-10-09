import {expect,it} from 'vitest';
import {buildMigrationPlan,type ProjectInspection,type ToolDecision} from '../src/migration/domain/migration-model.js';

it('cannot turn a name-only incomplete tool into an executable by selecting a generator',()=>{
  const inspection:ProjectInspection={assetId:'source',assetDigest:'a'.repeat(64),inspectedAt:'2026-10-01T00:00:00Z',
    scriptsExecuted:false,skill:{status:'NON_COMPLIANT',findings:[]},tools:[{
      toolId:'name-only',name:'declared_lookup',sourcePaths:['SKILL.md'],language:null,kind:'UNKNOWN',
      portability:'INCOMPLETE',inputSchema:null,outputSchema:null,samples:[],evidence:[],findings:[],
      recommendedForm:'MCP',recommendedLanguage:'java',recommendationReason:'Only a name, no implementation or contract',
    }]};
  for(const form of ['MCP','SCRIPT'] as const){
    const decision:ToolDecision={toolId:'name-only',form,reason:'user choice',baseAssetId:'source',decidedAt:'now'};
    const plan=buildMigrationPlan(inspection,[decision],'source');
    expect(plan.generationAllowed).toBe(false);
    expect(plan.items[0]!.blockingReasons.join()).toContain('工具实现或合同不完整');
  }
});
