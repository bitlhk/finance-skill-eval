import {it,expect,vi,beforeEach} from 'vitest';
const complete=vi.hoisted(()=>vi.fn());
vi.mock('../src/service/config.js',()=>({configuredModelRole:()=>({adapter:{complete},model:{providerId:'unit',modelId:'unit'}}),modelTimeoutMs:()=>10000}));
import {runReuseAcceptanceModel} from '../src/migration/infrastructure/migration-reuse-acceptance-model.js';
beforeEach(()=>{complete.mockReset();});
it('reports invalid fields and phase without returning model output',async()=>{
 complete.mockResolvedValue({content:JSON.stringify({checks:'PRIVATE_MODEL_OUTPUT'})});
 try{await runReuseAcceptanceModel({mode:'VERIFY',context:{}});throw new Error('must reject');}
 catch(error:any){expect(error.failure).toMatchObject({phase:'VERIFICATION',code:'MODEL_OUTPUT_INVALID',fields:['checks (invalid_type)']});expect(JSON.stringify(error.failure)).not.toContain('PRIVATE_MODEL_OUTPUT');}
 expect(complete).toHaveBeenCalledTimes(1);
});
it('redacts provider failure while retaining model stage',async()=>{
 complete.mockRejectedValue(new Error('https://private.host/?api_key=PRIVATE_SECRET'));
 await expect(runReuseAcceptanceModel({mode:'COVERAGE',context:{}})).rejects.toMatchObject({failure:{phase:'COVERAGE',code:'MODEL_REQUEST_FAILED'}});
 try{await runReuseAcceptanceModel({mode:'PLAN',context:{}})}catch(error:any){expect(error.message).not.toContain('PRIVATE_SECRET');}
});
it('does not reinterpret incomplete coverage as PASS or retry the verdict',async()=>{
 complete.mockResolvedValue({content:JSON.stringify({status:'INCOMPLETE',reasons:['Original requirement needs actual deployment switching']})});
 expect(await runReuseAcceptanceModel({mode:'COVERAGE',context:{}})).toMatchObject({status:'INCOMPLETE'});expect(complete).toHaveBeenCalledTimes(1);
});
const plan=(checkId='original')=>({name:'Execution',groups:[{id:'group',cases:[{id:'case',input:'Check the actual result',criteria:['Actual result']}]}],checks:[{checkId,caseIds:['case'],criteria:['Original requirement']}],unresolvedQuestions:[]});
const context={design:{scope:'Unchanged scope',acceptanceChecks:[{id:'original',purpose:'Business behavior',procedure:'Execute',expectedResult:'Actual result'}]}};
it('re-plans one generated reference mismatch against unchanged original requirements',async()=>{
 complete.mockResolvedValueOnce({content:JSON.stringify(plan('invented'))}).mockResolvedValueOnce({content:JSON.stringify(plan())});
 expect(await runReuseAcceptanceModel({mode:'PLAN',context})).toEqual(plan());expect(complete).toHaveBeenCalledTimes(2);
 const repair=complete.mock.calls[1]![0];expect(repair.toolFree).toBe(true);expect(repair.requestId).toContain('references-1');
 expect(repair.messages[1].content).toBe(JSON.stringify(context));expect(repair.messages.at(-1).content).toContain('validationErrors');
});
it('stops after one re-planning attempt and never relabels invented requirements itself',async()=>{
 complete.mockResolvedValue({content:JSON.stringify(plan('invented'))});
 await expect(runReuseAcceptanceModel({mode:'PLAN',context})).rejects.toMatchObject({failure:{phase:'PLAN',code:'MODEL_PLAN_REFERENCE_INVALID'}});expect(complete).toHaveBeenCalledTimes(2);
});
it('retains genuine unresolved requirements rather than retrying them away',async()=>{
 const unresolved={...plan(),unresolvedQuestions:['Original requirement needs a new deployment']};complete.mockResolvedValue({content:JSON.stringify(unresolved)});
 expect(await runReuseAcceptanceModel({mode:'PLAN',context})).toEqual(unresolved);expect(complete).toHaveBeenCalledTimes(1);
});
it('never regenerates a business verdict because references are incorrect',async()=>{
 const verdict={checks:[{checkId:'invented',status:'PASSED',reason:'A claim',caseIds:['case']}]};complete.mockResolvedValue({content:JSON.stringify(verdict)});
 expect(await runReuseAcceptanceModel({mode:'VERIFY',context})).toEqual(verdict);expect(complete).toHaveBeenCalledTimes(1);
});
it('does not silently truncate source or exceed the input budget when re-planning',async()=>{
 complete.mockResolvedValue({content:JSON.stringify(plan('invented'))});
 const large={...context,source:'x'.repeat(599_700)};
 await expect(runReuseAcceptanceModel({mode:'PLAN',context:large})).rejects.toMatchObject({failure:{phase:'PLAN',code:'INPUT_TOO_LARGE'}});expect(complete).toHaveBeenCalledTimes(1);
});
it('guides static condition checks into original check ids without inventing dynamic evidence',async()=>{
 complete.mockResolvedValue({content:JSON.stringify(plan())});await runReuseAcceptanceModel({mode:'PLAN',context});
 const instruction=complete.mock.calls[0]![0].messages[0].content;
 expect(instruction).toContain('相关原 check 的 checks.criteria');expect(instruction).toContain('candidateBinaryPaths');
 expect(instruction).toContain('不能凭空断言已测量运行环境');expect(complete).toHaveBeenCalledTimes(1);
});
