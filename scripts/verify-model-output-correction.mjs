/** Small live-model check for the format-only correction path; no business tools. */
import assert from 'node:assert/strict';
import {configuredModelRole} from '../dist/service/config.js';
import {correctModelOutput} from '../dist/migration/infrastructure/model-output-correction.js';

const role=configuredModelRole('ANALYZER');
assert(role.adapter,'Configure the analyzer model before this live check');
const corrected=await correctModelOutput({
  raw:'```json\n{"status":"PRODUCED","value":"ok",}\n```',
  check:value=>value&&typeof value==='object'&&value.status==='PRODUCED'&&value.value==='ok'
    ?{ok:true,value}:{ok:false,errors:['status/value: 保留原值并移除多余逗号']},
  adapter:role.adapter,model:role.model,requestId:`model-output-check-${Date.now()}`,maxRepairs:1,
});
assert(corrected.ok&&corrected.repairs===1,'Live model did not repair the malformed JSON');
console.log(JSON.stringify({passed:true,repairCalls:corrected.repairs}));
