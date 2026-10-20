// Metadata correction regression; real deployed tests use the actual code Agent.
import {afterEach,expect,it,vi} from 'vitest';
import * as runner from '../src/migration/infrastructure/migration-agent-runner.js';
import * as config from '../src/service/config.js';
import {OpenAiCompatibleModelAdapter} from '../src/openai-compatible-model.js';
import {runBundleAgent} from '../src/migration/tasks/infrastructure/task-agent.js';
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
