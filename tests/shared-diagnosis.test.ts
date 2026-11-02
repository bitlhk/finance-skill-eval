import {afterEach,expect,it,vi} from 'vitest';
import {createImprovementDiagnoser} from '../src/agents/improvement-diagnoser.js';
import type {ModelCompletionRequest} from '../src/adapters.js';
import type {AgentCompositionReceipt} from '../src/shared/contracts/agent-composition.js';

afterEach(()=>vi.useRealTimers());
const model={providerId:'custom',modelId:'optimizer',parameters:{}};
const input={modelId:'optimizer',sourceJobId:'run',baseSolutionRevisionId:'candidate',tools:[],runtimeConfiguration:[],technicalEvidence:[],cases:[]};
it('records the shared role and injected policy without exposing task content',async()=>{
  const requests:ModelCompletionRequest[]=[],receipts:AgentCompositionReceipt[]=[];
  const adapter={adapterId:'fixture',complete:async(request:ModelCompletionRequest)=>{
    requests.push(request);return {content:JSON.stringify({status:'ABSTAINED',reason:'Missing evidence'}),modelId:'optimizer'};
  }};
  const diagnose=createImprovementDiagnoser({adapter,model,capabilityFormat:{},policies:['ENTERPRISE_POLICY']});
  const result=await diagnose(input,{requestId:'diagnose',onComposition:r=>{receipts.push(r);}});
  expect(result.judgement.status).toBe('ABSTAINED');
  expect(result.agentComposition).toEqual(receipts[0]);
  expect(requests[0]).toMatchObject({toolFree:true});
  expect(requests[0]?.messages[0]?.content).toContain('ENTERPRISE_POLICY');
  expect(JSON.stringify(receipts)).not.toContain('ENTERPRISE_POLICY');
  const other=await createImprovementDiagnoser({adapter,model,capabilityFormat:{},policies:['OTHER_POLICY']})(input,{requestId:'other'});
  expect(other.agentComposition.inputDigest).not.toBe(result.agentComposition.inputDigest);
});
it('stops a diagnosis even if a custom model ignores cancellation',async()=>{
  vi.useFakeTimers();
  const diagnose=createImprovementDiagnoser({adapter:{adapterId:'ignores-signal',complete:()=>new Promise(()=>{})},model,capabilityFormat:{}});
  const pending=diagnose(input,{requestId:'timeout',timeoutMs:10});
  const asserted=expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(11);
  await asserted;
});
