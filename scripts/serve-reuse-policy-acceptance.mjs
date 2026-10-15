/** Inspect a real-model plan revision through UI in a copy, never rewrite prior evidence. */
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {createEvaluationService} from '../dist/service/server.js';

const root=process.cwd(),sourceWork=process.env.REUSE_POLICY_SOURCE_WORK;
assert(sourceWork,'Select the previous real UI host explicitly with REUSE_POLICY_SOURCE_WORK');
const previous=JSON.parse(await readFile(path.join(sourceWork,'service.json'),'utf8'));
assert.equal(path.resolve(previous.data),path.resolve(sourceWork,'data'));
const work=await mkdtemp(path.join(os.tmpdir(),'reuse-policy-ui-')),data=path.join(work,'data');
await cp(previous.data,data,{recursive:true,errorOnExist:true});
const app=await createEvaluationService({rootDirectory:root,dataDirectory:data,publicDirectory:path.join(root,'web-dist'),publicDemo:false,accessToken:'reuse-policy-ui'});
app.log.level='error';const url=await app.listen({host:'127.0.0.1',port:0});
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});
const diff=git('diff','HEAD');
const sourcePaths=git('ls-files','--cached','--others','--exclude-standard','--','src','web','scripts/serve-reuse-policy-acceptance.mjs').trim().split(/\r?\n/u).filter(Boolean).sort();
const sourceHashes=await Promise.all(sourcePaths.map(async name=>[name,createHash('sha256').update(await readFile(path.join(root,name))).digest('hex')]));
const manifest={url,work,data,sourceWork,evalCommit:git('rev-parse','HEAD').trim(),
  sourceTreeSha256:createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex'),
  trackedPatchSha256:createHash('sha256').update(diff).digest('hex'),purpose:'REAL_MODEL_PLAN_REVISION_ONLY',
  note:'Dirty implementation pin; not a full migration execution or fixed-version final signoff'};
await writeFile(path.join(work,'service.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({url,work,status:'READY'}));
process.once('SIGINT',()=>void app.close());process.once('SIGTERM',()=>void app.close());
