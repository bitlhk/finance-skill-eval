import {expect,it} from 'vitest';
import {evidenceLabels} from '../src/evidence-labels.js';
it('distinguishes disabled collection, missing events and observed calls',()=>{
  expect(evidenceLabels({toolEvidenceCollection:{status:'DISABLED'}},0).tools).toContain('未采集');
  expect(evidenceLabels({},0).tools).toContain('尚不能确认');
  expect(evidenceLabels({},2).tools).toContain('2 项');
});
it('never promotes a running archive snapshot or terminal outcome to cleanup evidence',()=>{
  const value=evidenceLabels({archiveStatus:'RECORDING',status:'completed'});
  expect(value.archive).toContain('不代表最终');
  expect(value.cleanup).toContain('不代表已回收');
});
