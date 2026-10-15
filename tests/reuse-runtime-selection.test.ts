import {expect,it} from 'vitest';
import {unavailableReuseTargets} from '../web/src/MigrationReuseAcceptance.js';
it('keeps unavailable historical choices visible without deleting or replacing them',()=>{
  const historical={environmentId:'old-deployment',modelId:'old-model'},current={environmentId:'new-deployment',modelId:'new-model'};
  const selected=[historical,current],before=structuredClone(selected);
  expect(unavailableReuseTargets(selected,[{runtimeId:'new-deployment'}])).toEqual([historical]);
  expect(selected).toEqual(before);
  expect(unavailableReuseTargets(selected,[])).toEqual(selected);
  expect(unavailableReuseTargets(selected,[{runtimeId:'old-deployment'},{runtimeId:'new-deployment'}])).toEqual([]);
});
