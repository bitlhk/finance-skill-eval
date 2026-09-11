import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';

// Own synthetic assets only; never execute imported customer code.
const root=path.resolve('examples/migration-native-host');
const data=await mkdtemp(path.join(tmpdir(),'native-migration-'));
const token=randomBytes(32).toString('hex');
await writeFile(path.join(data,'access-token'),token,{mode:0o600});
await writeFile(path.join(data,'grant.json'),JSON.stringify({active:true,subject:'synthetic-reference-customer',scope:'reference:balance:read',expiresAt:new Date(Date.now()+600000).toISOString()}));
const fixtures=Object.fromEntries(['normal','zero','missing','holdout'].map((name)=>['reference-'+name,{status:name==='missing'?'MISSING':'COMPLETED',amount:name==='missing'?null:name==='zero'?'0.00':'12345.67',currency:'CNY',source:'CONTROLLED_SYNTHETIC_BANK',asOf:'2026-09-11T00:00:00Z'}]));
await writeFile(path.join(data,'fixtures.json'),JSON.stringify(fixtures));
const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
const cp=await readFile(path.join(root,'target/classpath.txt'),'utf8');
const child=spawn('java',['-cp',path.join(root,'target/classes')+path.delimiter+cp.trim(),'NativeMigrationHost'],{env:{...process.env,MIGRATION_HOST_DATA:data,MIGRATION_HOST_PORT:String(port)},stdio:['ignore','pipe','pipe']});
// Do not print SDK logs or credentials; failures are surfaced through sanitized evidence.
child.stdout.resume();child.stderr.resume();
const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
const url='http://127.0.0.1:'+port;
let health;
const report={mode:'REAL_OPENJIUWEN_REAL_MODEL_SYNTHETIC_DATA',checks:[],webpageVerified:false,pfNativeEquivalent:false};
try{
  for(let i=0;i<100;i++){try{const r=await fetch(url+'/health',{headers});if(r.ok){health=await r.json();break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert(health?.modelConfigured,'MODEL_OR_HOST_UNAVAILABLE');report.host=health;
  const contract={method:'SKILL.md',mappingReview:{approved:true},capabilities:health.tools.map(({name,inputSchema,outputSchema})=>({name,inputSchema,outputSchema})),resources:[{path:'references/rules.md',visibility:'METHOD_CONTEXT'}]};
  const files={'SKILL.md':'---\nname: reference-balance\nversion: 1.0.0\n---\nUse query_account_balance to describe the balance. State currency, source, and asOf. Missing is not zero.','references/rules.md':'Report missing balance explicitly; never infer an amount.','migration-generated/neutral-contract.json':JSON.stringify(contract)};
  const canonicalArchive=JSON.stringify(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)).map(([name,content])=>({content:Buffer.from(content).toString('base64'),name})));
  const digest=createHash('sha256').update(canonicalArchive).digest('hex');report.digest=digest;
  const request={runId:'native-reference',side:'right',case:{caseId:'reference-normal',prompt:'请调用工具查询余额，说明金额、币种、来源和时间。'},model:{modelId:health.modelId},skill:{skillId:'reference-balance',version:'1.0.0',artifactSha256:digest,canonicalArchive}};
  for(const name of ['normal','zero','missing','denied']){
    const r=await fetch(url+'/execute',{method:'POST',headers,body:JSON.stringify({...request,case:{...request.case,caseId:'reference-'+name}}),signal:AbortSignal.timeout(190000)});
    const evidence=await r.json();assert.equal(r.status,200,JSON.stringify(evidence));
    if(name==='denied'){assert.equal(evidence.status,'failed');assert.equal(evidence.error,'AUTHORIZATION_REJECTED');assert.equal(evidence.metadata.modelCalls,0);assert.equal(evidence.metadata.businessReads,0);}
    else{assert.equal(evidence.status,'completed',JSON.stringify(evidence));assert(evidence.metadata.modelResponses>=2);assert(evidence.metadata.businessReads>0);assert.equal(evidence.metadata.skillArtifactSha256,digest);assert.deepEqual(evidence.metadata.toolTrace[0].result,fixtures['reference-'+name]);}
    report.checks.push({name,evidence});
  }
  const stale=await fetch(url+'/execute',{method:'POST',headers,body:JSON.stringify({...request,skill:{...request.skill,artifactSha256:'0'.repeat(64)}})});
  assert.equal(stale.status,422);assert.equal((await stale.json()).reason,'ASSET_DIGEST_MISMATCH');report.checks.push({name:'wrong-digest',rejected:true});
  const identity=await fetch(url+'/execute',{method:'POST',headers,body:JSON.stringify({...request,skill:{...request.skill,version:'2.0.0'}})});
  assert.equal(identity.status,422);assert.equal((await identity.json()).reason,'METHOD_IDENTITY_MISMATCH');report.checks.push({name:'wrong-method-version',rejected:true});
  await writeFile(path.join(data,'grant.json'),JSON.stringify({active:false,subject:'synthetic-reference-customer',scope:'reference:balance:read',expiresAt:new Date(Date.now()+60000).toISOString()}));
  const revoked=await fetch(url+'/execute',{method:'POST',headers,body:JSON.stringify(request)});const denied=await revoked.json();assert.equal(denied.error,'AUTHORIZATION_REJECTED');assert.equal(denied.metadata.modelCalls,0);assert.equal(denied.metadata.businessReads,0);report.checks.push({name:'actual-host-grant-revoked',rejected:true});
}finally{
  child.kill('SIGTERM');if(child.exitCode===null)await once(child,'exit');
  await rm(data,{recursive:true,force:true});
  if(process.argv[2])await writeFile(path.resolve(process.argv[2]),JSON.stringify(report,null,2),{mode:0o600});
}
console.log(JSON.stringify({mode:report.mode,checks:report.checks.map(c=>c.name),webpageVerified:false,pfNativeEquivalent:false}));
