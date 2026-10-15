import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {enterpriseSkills,selectedEnterpriseCases,summarizeAcceptance} from './lib/migration-acceptance-results.mjs';
import {capabilitySkills} from '../acceptance/capability-migration/manifest.mjs';

// Use verify-migration-v2-ui.mjs directly for explicitly STUBBED UI regression.
assert(process.env.MIGRATION_TEST_LAUNCHER_INFO,'Real acceptance requires a private, live Launcher connection file');
assert(process.env.MIGRATION_TEST_REAL_AGENTS!=='false','Use the regression entry point for stubbed agents');
assert(['MIGRATION_TEST_RESUME_DATA','ENTERPRISE_TEST_A2_RECORD','ENTERPRISE_TEST_A4_RECORD',
  'ENTERPRISE_TEST_CANDIDATE_A2_RECORD','ENTERPRISE_TEST_REUSE_RECORD','ENTERPRISE_TEST_REVIEW_DIRECTORY']
  .every(key=>!process.env[key]), 'Fresh Skill acceptance cannot reuse diagnosis, design, generated candidates or review');
const selected=selectedEnterpriseCases(process.env.ENTERPRISE_TEST_CASES);
const root=process.cwd(),runId=randomUUID(),directory=path.join(root,'reports',`migration-acceptance-${runId}`);
await mkdir(directory,{recursive:true});
const startedAt=Date.now(),children=[];
const capabilitySelected=process.env.CAPABILITY_TEST_SKILLS?.split(',').map(s=>s.trim())??Object.keys(capabilitySkills);
assert(capabilitySelected.length&&new Set(capabilitySelected).size===capabilitySelected.length&&capabilitySelected.every(id=>Object.hasOwn(capabilitySkills,id)));
const requestedSkills=['openjiuwen-portability-acceptance',...selected.map(id=>enterpriseSkills[id]),...capabilitySelected];
for(const script of ['verify-migration-v2-ui.mjs','verify-enterprise-examples-page.mjs','verify-capability-skills-ui.mjs']) {
  const resultPath=path.join(directory,script+'.json');
  const exitCode=await new Promise(resolve=>{
    const child=spawn(process.execPath,[...process.execArgv,path.join(root,'scripts',script)],{
      cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,MIGRATION_TEST_REAL_AGENTS:'true',
        MIGRATION_ACCEPTANCE_RUN_ID:runId,MIGRATION_ACCEPTANCE_RESULT:resultPath},
    });
    child.once('error',()=>resolve(-1));child.once('exit',code=>resolve(code??-1));
  });
  let result;try{result=JSON.parse(await readFile(resultPath,'utf8'));}catch{}
  children.push({exitCode,result});
  // A failed primary path must not hide the other Skill results.
  const summary=summarizeAcceptance({runId,requestedSkills,children});
  await writeFile(path.join(directory,'result.json'),JSON.stringify({...summary,elapsedMs:Date.now()-startedAt},null,2)+'\n');
}
const summary=summarizeAcceptance({runId,requestedSkills,children});
process.stdout.write(JSON.stringify(summary,null,2)+'\n');
if(!summary.realModelScenarioAcceptancePassed)process.exitCode=1;
