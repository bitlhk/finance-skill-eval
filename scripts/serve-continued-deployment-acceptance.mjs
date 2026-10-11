/** Continue real UI evidence in a copy; existing Launcher owners stay untouched. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,cp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {createEvaluationService} from '../dist/service/server.js';
const root=process.cwd(),git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
assert(!git('status','--porcelain'),'Commit implementation before acceptance');
const original=path.resolve(process.env.CLOSEOUT_CONTINUE_WORK??'');
assert(process.env.CLOSEOUT_CONTINUE_WORK,'Explicit previous real acceptance host required');
const prior=JSON.parse(await readFile(path.join(original,'service.json'),'utf8'));
assert(prior.launcherBackend==='NATIVE_PACKAGE'&&prior.admitted?.length===2,'Requires two previously independently admitted deployments');
const privateDelivery=JSON.parse(await readFile(path.join(original,'launcher/deliveries.json'),'utf8'));
assert(privateDelivery.status==='READY'&&privateDelivery.records.length===2);
const parentWork=process.env.CLOSEOUT_CONTINUE_DATA_WORK?path.resolve(process.env.CLOSEOUT_CONTINUE_DATA_WORK):original;
const parent=parentWork===original?prior:JSON.parse(await readFile(path.join(parentWork,'service.json'),'utf8'));
assert(parent.launcherBackend==='NATIVE_PACKAGE'&&parent.admitted?.length===2,'Data parent must preserve the admitted deployments');
assert(JSON.stringify(parent.admitted)===JSON.stringify(prior.admitted),'Data and credential hosts must identify the same deployments');
assert(path.resolve(parent.data)===path.join(parentWork,'data'),'Data must belong to the explicitly selected acceptance host');
const work=await mkdtemp(path.join(os.tmpdir(),'continued-deployment-ui-')),data=path.join(work,'data');
await cp(parent.data,data,{recursive:true,errorOnExist:true});
const trust=privateDelivery.records.map((r,i)=>{
 const credentialEnv=`CLOSEOUT_DEPLOYMENT_${i}_TOKEN`;process.env[credentialEnv]=r.connection.token;
 return {reference:`acceptance-${i}`,label:`验收部署 ${i+1}`,baseUrlPrefix:r.connection.baseUrl,credentialEnv};
});
for(const suffix of ['PROVIDER','BASE_URL','API_KEY','MODEL','REQUEST_DEFAULTS','TIMEOUT_MS']){
 const value=process.env[`FINANCE_EVAL_ANALYZER_${suffix}`];if(value!==undefined)process.env[`FINANCE_EVAL_OPTIMIZER_${suffix}`]=value;
}
process.env.FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS='1';process.env.FINANCE_EVAL_AGENT_DUMP=path.join(work,'agent-logs');
const app=await createEvaluationService({rootDirectory:root,dataDirectory:data,publicDirectory:path.join(root,'web-dist'),publicDemo:false,accessToken:'cross-deployment-ui',launcherTrust:trust});
app.log.level='error';const url=await app.listen({host:'127.0.0.1',port:0});
const defaults=JSON.parse(process.env.FINANCE_EVAL_ANALYZER_REQUEST_DEFAULTS??'{}');
// Whitelist only non-secret operator budgets, never dump arbitrary provider defaults.
const analyzerBudget={};
for(const field of ['max_tokens','max_completion_tokens'])if(Number.isSafeInteger(defaults[field])&&defaults[field]>0)analyzerBudget[field]=defaults[field];
if(['none','low','medium','high','max','minimal','xhigh'].includes(defaults.reasoning_effort))analyzerBudget.reasoning_effort=defaults.reasoning_effort;
await writeFile(path.join(work,'service.json'),JSON.stringify({url,work,data,eval:git('rev-parse','HEAD'),builder:prior.builder,
 provenance:'CONTINUED_REAL_UI_DATA',originalEval:prior.eval,parentEval:parent.eval,parentWork,launcherBackend:'NATIVE_PACKAGE',harnessExecuted:false,admitted:prior.admitted,analyzerBudget},null,2));
console.log(JSON.stringify({url,work,status:'READY_FOR_CONTINUED_UI'}));
let closed=false;async function close(){if(closed)return;closed=true;await app.close()}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
while(!closed){try{await readFile(path.join(work,'stop'));await close()}catch(e){if(e.code!=='ENOENT')throw e}await new Promise(r=>setTimeout(r,500))}
