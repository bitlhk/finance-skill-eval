import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { createEvaluationService } from '../src/service/server.js';
import { bundleZip, type BundleTask, type BundleFiles, type BundleAnalysis } from '../src/migration/tasks/domain/task-model.js';
import type { BundleAgent, BundleAgentInput } from '../src/migration/tasks/application/task-ports.js';

const cleanup: Array<()=>Promise<unknown>>=[];
afterEach(async()=>{while(cleanup.length)await cleanup.pop()!();});
export const encode=(text:string)=>Buffer.from(text).toString('base64');
export const standardFiles:BundleFiles={
  'skills/method/SKILL.md':encode('---\nname: method\ndescription: Review a document\n---\nRead ../../shared/rules.json and cite evidence.'),
  'shared/rules.json':encode('{"limit":100}'),
};
export async function taskHttpFixture(options:{files?:BundleFiles;count?:number;agent?:BundleAgent;publicDemo?:boolean}={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'standard-task-http-'));
  cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const seen:BundleAgentInput[]=[];
  const control:{analysis:BundleAnalysis;error?:string;abstain?:string;files?:BundleFiles;services:any[];executionFailure?:boolean;badIdentity?:boolean;judgeFailure?:boolean;verdict:boolean}={
    analysis:{summary:'Inspect the selected workspace',changes:[],missing:[]},services:[],verdict:true,
  };
  const app=await createEvaluationService({dataDirectory:root,rootDirectory:path.resolve('.'),accessToken:'test-private-token',publicDemo:options.publicDemo??false,
    bundlePorts:{
      agent:async input=>{
        seen.push(input);
        if(options.agent)return options.agent(input);
        if(control.error)throw new Error(control.error);
        if(control.abstain)return {status:'ABSTAINED',reason:control.abstain};
        return input.mode==='ANALYZE'?{status:'PRODUCED',analysis:control.analysis}
          :{status:'PRODUCED',files:control.files??input.base.files,delivery:{summary:'Whole-workspace candidate',services:control.services}};
      },
      runtime:async({snapshot})=>({model:{providerId:'controlled-regression',modelId:'model',parameters:{}},environmentSnapshot:{fixture:'standard-regression'},runtime:{
        adapterId:'controlled-regression',prepare:async()=>{},cleanup:async()=>{},finalizationEvidence:()=>({status:'RELEASED'}),
        execute:async request=>({runId:request.runId,caseId:request.evalCase.caseId,side:'right',modelId:'model',skillVersion:null,
          status:control.executionFailure?'failed':'completed',output:'Observed document evidence',elapsedMs:1,toolCalls:[],
          loadedSkills:snapshot.members.map(m=>({skillId:m.skillId,version:m.version})),usage:null,runtimeIdentityVerified:!control.badIdentity,streamCompleted:true,
          error:control.executionFailure?'CONTROLLED_EXECUTION_FAILURE':null,metadata:{contentDigest:snapshot.digest}}),
      }}),
      judge:async()=>{if(control.judgeFailure)throw new Error('CONTROLLED_JUDGE_FAILURE');return {passed:control.verdict,reason:'Controlled business assertion'};},
    },
  });cleanup.push(()=>app.close());
  const headers={authorization:'Bearer test-private-token'};
  const api=(method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:any)=>app.inject({method,url,headers,...(payload===undefined?{}:{payload})});
  const files=options.files??{...standardFiles,...Object.fromEntries(Array.from({length:(options.count??1)-1},(_,i)=>[
    `skills/member-${i}/SKILL.md`,encode(`---\nname: member-${i}\ndescription: Collaborating Skill\n---\nApply the shared rules.`)]))};
  async function upload(nextFiles=files){return app.inject({method:'POST',url:'/api/migration-tasks/upload?name=Review&goal=Review%20documents&target=OpenJiuwen',headers:{...headers,'content-type':'application/zip'},payload:bundleZip(nextFiles)});}
  let task:BundleTask;
  if(!options.publicDemo){const created=await upload();expect(created.statusCode,created.body).toBe(200);task=created.json();}
  const url=()=>'/api/migration-tasks/'+task.id;
  async function get(){const response=await api('GET',url());expect(response.statusCode,response.body).toBe(200);task=response.json();return task;}
  async function start(route:string,body:Record<string,unknown>={}){await get();return api('POST',url()+'/'+route,{key:randomUUID(),baseCandidateId:task.currentCandidateId,...body});}
  async function finish(route:string,body:Record<string,unknown>={}){
    const response=await start(route,body);expect(response.statusCode,response.body).toBe(202);
    for(let i=0;i<200;i++){await get();if(!task.attempts.some(a=>a.status==='RUNNING'))return task;await new Promise(r=>setTimeout(r,10));}
    throw Error('Task did not finish');
  }
  async function candidate(){await finish('analysis');return finish('generate');}
  async function ready(){await candidate();await api('PUT',url()+'/configuration',{environmentId:'fixture',modelId:'model',timeoutMs:10000});await api('PUT',url()+'/suite',{name:'Review',cases:[{id:'development',input:'Review document',criteria:['Cite evidence']}],holdoutCases:[{id:'held',input:'HOLDOUT_SECRET',criteria:['HOLDOUT_CRITERION']}]});return get();}
  async function file(name:string,candidateId?:string){const response=await api('GET',url()+'/file?path='+encodeURIComponent(name)+(candidateId?'&candidateId='+candidateId:''));expect(response.statusCode,response.body).toBe(200);return response.json().content as string;}
  async function exported(verified=false){const response=await api('GET',url()+'/export'+(verified?'?verified=true':''));expect(response.statusCode,response.body).toBe(200);return unzipSync(response.rawPayload);}
  async function buildRequest(overrides:Record<string,unknown>={}){await get();return api('POST',url()+'/runtime-build-requests',{
    baseCandidateId:task.currentCandidateId,runtimeType:'openjiuwen',platform:{os:'linux',arch:'x64',isolation:'trusted_local_process'},timeoutMs:10000,harnessTools:[],...overrides});}
  return {app,root,headers,control,seen,files,api,upload,get,start,finish,candidate,ready,file,exported,url,buildRequest};
}
