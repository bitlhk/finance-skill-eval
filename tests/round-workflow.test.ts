import {expect,it,vi} from 'vitest';
import {runRoundWorkflow,type RoundWorkflow} from '../src/improvement/application/round-workflow.js';

function workflow():RoundWorkflow<string,string,string,string>{
  return {firstRound:1,maxRounds:2,signal:new AbortController().signal,
    prepare:vi.fn(async()=>true),diagnose:vi.fn(async()=>({status:'READY',value:'diagnosis'})),
    adjust:vi.fn(async()=>({status:'READY',value:'candidate'})),evaluate:vi.fn(async()=>'evidence'),
    review:vi.fn(async()=>'review'),select:vi.fn(async()=>true),exhausted:vi.fn(async()=>{})};
}
it('resumes external Runtime work in the same round without repeating edits or consuming another round',async()=>{
  const ports=workflow();ports.firstRound=2;ports.resume=vi.fn(async()=>'deployed-candidate');
  await runRoundWorkflow(ports);
  expect(ports.diagnose).not.toHaveBeenCalled();expect(ports.adjust).not.toHaveBeenCalled();
  expect(ports.evaluate).toHaveBeenCalledWith('deployed-candidate',2);
  expect(ports.review).toHaveBeenCalledWith('deployed-candidate','evidence',2);
  expect(ports.select).toHaveBeenCalledWith('deployed-candidate','evidence','review',2);
  expect(ports.exhausted).not.toHaveBeenCalled();
});
it('keeps waiting work out of evaluation and does not mark its budget exhausted',async()=>{
  const ports=workflow();ports.adjust=vi.fn(async()=>({status:'STOP'}));
  await runRoundWorkflow(ports);
  expect(ports.evaluate).not.toHaveBeenCalled();expect(ports.exhausted).not.toHaveBeenCalled();
});
it('does not review or select evidence returned after cancellation',async()=>{
  const ports=workflow(),controller=new AbortController();ports.signal=controller.signal;
  ports.evaluate=vi.fn(async()=>{controller.abort();return 'late-evidence';});
  await expect(runRoundWorkflow(ports)).rejects.toThrow();
  expect(ports.review).not.toHaveBeenCalled();expect(ports.select).not.toHaveBeenCalled();
});
