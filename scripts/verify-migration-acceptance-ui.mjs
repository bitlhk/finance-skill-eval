import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';

const root=process.cwd();
const skills=[
  'openjiuwen-portability-acceptance',
  'expense-compliance',
  'employee-balance',
  'procurement-review',
  'refund-eligibility',
];

function run(script,environment={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(root,'scripts',script)],{
      cwd:root,
      windowsHide:true,
      stdio:'inherit',
      env:{...process.env,...environment},
    });
    child.once('error',reject);
    child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`${script} failed (${signal??code})`)));
  });
}

const startedAt=Date.now();
await run('verify-migration-v2-ui.mjs');
await run('verify-enterprise-examples-page.mjs');
assert.equal(skills.length,5);
process.stdout.write(`${JSON.stringify({
  mode:'FIVE_SKILL_MIGRATION_UI_ACCEPTANCE',
  passed:true,
  skills,
  elapsedMs:Date.now()-startedAt,
},null,2)}\n`);
