import {afterEach,expect,it,vi} from 'vitest';
import {createAdjustmentAgent,type AdjustmentInput} from '../src/agents/adjustment-agent.js';
import {createSkillEditor} from '../src/agents/tool-free-roles.js';
import {loadAgentRole} from '../src/agents/composition.js';
import type {ModelCompletionRequest} from '../src/adapters.js';
import type {AgentCompositionReceipt} from '../src/shared/contracts/agent-composition.js';

afterEach(()=>vi.restoreAllMocks());
const model={providerId:'fixture',modelId:'adjuster',parameters:{}};
const files={'SKILL.md':'Use old response field','scripts/tool.py':'return old_field','notes.txt':'Read only context'};
const docChange={path:'SKILL.md',content:'Use the amount field',reason:'Match the corrected tool response'};
const toolChange={path:'scripts/tool.py',content:'return amount',reason:'Return the correct field'};
const proposal={summary:'Align implementation and instructions',findings:['Observed interface mismatch'],changes:[docChange,toolChange]};
const permissions={documents:{skillPaths:['SKILL.md'],referencePrefixes:['references']},tools:[{toolId:'lookup',paths:['scripts/tool.py']}]};
const input:AdjustmentInput={files,permissions,developmentEvidence:[{task:'Look up amount',answer:'Wrong field'}]};
function dependency(output:unknown=proposal){
  const complete=vi.fn(async(_:ModelCompletionRequest)=>({content:JSON.stringify(output),modelId:model.modelId}));
  return {model,adapter:{adapterId:'fixture',complete},complete};
}

it('coordinates document and tool changes in one call with one role and combined guidance',async()=>{
  const d=dependency(),receipts:AgentCompositionReceipt[]=[];
  const result=await createAdjustmentAgent(d)(input,{requestId:'combined',onComposition:r=>{receipts.push(r);}});
  expect(result).toEqual({status:'PRODUCED',proposal});
  expect(d.complete).toHaveBeenCalledTimes(1);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({role:'adjustment',tools:[],writeScope:'none'});
  expect(receipts[0]?.resources.map(r=>r.path)).toEqual(expect.arrayContaining([
    'skills/skill-optimization/SKILL.md','skills/tool-optimization/SKILL.md']));
  expect(receipts[0]?.resources.map(r=>r.path)).not.toContain('skills/runtime-adjustment/SKILL.md');
  expect(d.complete.mock.calls[0]?.[0].toolFree).toBe(true);
});

it.each([
  {permissions:{documents:permissions.documents},changes:[toolChange]},
  {permissions:{tools:permissions.tools},changes:[docChange]},
  {permissions,changes:[{...toolChange,path:'notes.txt'}]},
  {permissions,changes:[{...toolChange,path:'../scripts/tool.py'}]},
  {permissions,changes:[toolChange,toolChange]},
])('does not widen the caller permission or accept duplicate paths: %j',async example=>{
  const d=dependency({...proposal,changes:example.changes});
  await expect(createAdjustmentAgent(d)({...input,permissions:example.permissions},{requestId:'restricted'})).rejects.toThrow();
});

it('assembles engineering tools for the same role and rejects unsupported selections',()=>{
  const role=loadAgentRole('adjustment','v1',{execution:'engineering',capabilities:['document','tool','runtime']});
  expect(role.role).toBe('adjustment');
  expect(role.definition.tools).toEqual(expect.arrayContaining(['write_file','edit_file','compile_source']));
  expect(role.definition.tools).not.toContain('bash');
  expect(role.resources.map(r=>r.path)).toContain('skills/enterprise-standardization/SKILL.md');
  expect(()=>loadAgentRole('adjustment','v1',{execution:'proposal',capabilities:['runtime']})).toThrow();
  expect(()=>loadAgentRole('adjustment','v1',{execution:'proposal',capabilities:['tool','tool']})).toThrow();
});
