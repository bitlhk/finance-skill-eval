// Structured-response regressions only. Deployed acceptance uses real models.
import {afterEach,expect,it,vi} from 'vitest';
import * as config from '../src/service/config.js';
import {judgeBundleCase} from '../src/migration/tasks/infrastructure/task-agent.js';
import {evalCaseSchema} from '../src/contracts.js';
const evalCase=evalCaseSchema.parse({caseId:'case',name:'Case',prompt:'Assess',evaluationGoal:'Check rules',requiredTools:[],rubric:['one','two'].map(criterionId=>({criterionId,label:criterionId,description:criterionId,dimension:'business_completeness',weight:1}))});
const input={evalCase,evidence:{output:'Observed assessment'} as never,signal:new AbortController().signal};
afterEach(()=>vi.restoreAllMocks());
function adapter(){
  const complete=vi.fn();
  vi.spyOn(config,'configuredModelRole').mockReturnValue({configured:true,model:{providerId:'test',modelId:'test',parameters:{}},adapter:{adapterId:'structured-response-test',complete}});
  return complete;
}
const response=(criteria:unknown)=>({content:JSON.stringify({criteria}),modelId:'test'});
const check=(id:string,passed=true)=>({id,passed,reason:'Observed evidence'});
it('retries incomplete IDs once and preserves existing negative verdicts',async()=>{
  const complete=adapter().mockResolvedValueOnce(response([check('one',false)])).mockResolvedValueOnce(response([check('one',false),check('two')]));
  expect((await judgeBundleCase(input)).passed).toBe(false);
  expect(complete).toHaveBeenCalledTimes(2);
  const correction=JSON.parse(complete.mock.calls[1]![0].messages[1].content);
  expect(correction.requiredCriterionIds).toEqual(['one','two']);expect(correction.preservedVerdicts).toEqual({one:false});
});
it('does not retry a complete business failure',async()=>{
  const complete=adapter().mockResolvedValue(response([check('one',false),check('two')]));
  expect((await judgeBundleCase(input)).passed).toBe(false);expect(complete).toHaveBeenCalledTimes(1);
});
it('rejects a format retry that changes an existing verdict',async()=>{
  const complete=adapter().mockResolvedValueOnce(response([check('one',false)])).mockResolvedValueOnce(response([check('one'),check('two')]));
  await expect(judgeBundleCase(input)).rejects.toThrow('改变');expect(complete).toHaveBeenCalledTimes(2);
});
it('bounds malformed response retries and never retries provider failure',async()=>{
  const complete=adapter().mockResolvedValue({content:'invalid json',modelId:'test'});
  await expect(judgeBundleCase(input)).rejects.toThrow();expect(complete).toHaveBeenCalledTimes(2);
  complete.mockReset().mockRejectedValue(new Error('Provider unavailable'));
  await expect(judgeBundleCase(input)).rejects.toThrow('Provider unavailable');expect(complete).toHaveBeenCalledTimes(1);
});
