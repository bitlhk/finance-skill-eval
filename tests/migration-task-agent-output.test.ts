// Metadata correction regression; real deployed tests use the actual code Agent.
import {afterEach,expect,it,vi} from 'vitest';
import * as runner from '../src/migration/infrastructure/migration-agent-runner.js';
import * as config from '../src/service/config.js';
import {OpenAiCompatibleModelAdapter} from '../src/openai-compatible-model.js';
import {runBundleAgent} from '../src/migration/tasks/infrastructure/task-agent.js';
import type {AgentCompositionReceipt} from '../src/shared/contracts/agent-composition.js';
afterEach(()=>vi.restoreAllMocks());
function setup(replacement:unknown){
  const files={'SKILL.md':'IyBDYW5kaWRhdGU='};
  const agent=vi.spyOn(runner,'runMigrationAgent').mockResolvedValue({status:'PRODUCED',payload:{judgement:{delivery:{summary:'Actual changes',services:[],filePaths:['SKILL.md']}},files}} as never);
  vi.spyOn(runner,'migrationAgentEnabled').mockReturnValue(true);
  const adapter=new OpenAiCompatibleModelAdapter({apiKey:'test',baseUrl:'http://127.0.0.1:1'});
  const complete=vi.spyOn(adapter,'complete').mockResolvedValue({content:JSON.stringify(replacement),modelId:'test'});
  vi.spyOn(config,'configuredModelRole').mockReturnValue({configured:true,model:{providerId:'test',modelId:'test',parameters:{}},adapter});
  const input={mode:'GENERATE',base:{digest:'a'.repeat(64),files,members:[]},source:{digest:'a'.repeat(64),files,members:[]},goal:'Migrate',target:'Runtime',signal:new AbortController().signal} as const;
  return {agent,complete,files,input};
}
it('corrects redundant metadata with no second code-agent run or file changes',async()=>{
  const f=setup({summary:'Actual changes',services:[]});
  const result=await runBundleAgent(f.input);
  expect(result.delivery).toEqual({summary:'Actual changes',services:[]});expect(result.files).toBe(f.files);
  expect(f.agent).toHaveBeenCalledTimes(1);expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.complete.mock.calls[0]![0].toolFree).toBe(true);
});
it('rejects metadata correction that changes the declared delivery',async()=>{
  const f=setup({summary:'Invented changes',services:[]});
  await expect(runBundleAgent(f.input)).rejects.toThrow('改变');expect(f.agent).toHaveBeenCalledTimes(1);
});
it('does not invent a complete proposal from a summary-only analysis',async()=>{
  const f=setup({});
  f.agent.mockResolvedValue({status:'PRODUCED',payload:{judgement:{analysis:{summary:'Only prose',changes:[],missing:[]}},files:f.files}} as never);
  await expect(runBundleAgent({...f.input,mode:'ANALYZE'})).rejects.toThrow('完整迁移方案');
  expect(f.complete).not.toHaveBeenCalled();
});
it('requires per-tool diagnosis instead of silently accepting only a plan',async()=>{
  const f=setup({});
  f.agent.mockResolvedValue({status:'PRODUCED',payload:{judgement:{analysis:{summary:'Only plan',changes:[],missing:[],plan:{}}},files:f.files}} as never);
  await expect(runBundleAgent({...f.input,mode:'ANALYZE'})).rejects.toThrow('逐项工具诊断');
  expect(f.complete).not.toHaveBeenCalled();
});

it('runs a combined engineering adjustment once and records the shared role',async()=>{
  const f=setup({summary:'Actual changes',services:[]}),receipts:AgentCompositionReceipt[]=[];
  const combined={...f.files,'scripts/tool.py':Buffer.from('return amount').toString('base64')};
  f.agent.mockResolvedValue({status:'PRODUCED',payload:{judgement:{delivery:{summary:'Actual changes',services:[]}},files:combined}} as never);
  const result=await runBundleAgent({...f.input,mode:'REPAIR',adjustmentCapabilities:['document','tool','runtime'],
    onComposition:r=>{receipts.push(r);}});
  expect(f.agent).toHaveBeenCalledTimes(1);
  expect(f.agent.mock.calls[0]?.[1].bundle).toMatchObject({mode:'REPAIR',adjustmentCapabilities:['document','tool','runtime']});
  expect(result.files).toEqual(combined);
  expect(receipts[0]).toMatchObject({role:'adjustment',writeScope:'candidate',budget:{kind:'agentIterations'}});
  expect(receipts[0]?.resources.map(r=>r.path)).toEqual(expect.arrayContaining([
    'skills/skill-optimization/SKILL.md','skills/tool-optimization/SKILL.md','skills/runtime-adjustment/SKILL.md']));
});
