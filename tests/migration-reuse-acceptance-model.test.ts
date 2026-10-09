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
