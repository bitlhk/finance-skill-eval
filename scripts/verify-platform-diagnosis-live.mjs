import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {zipSync} from 'fflate';

// Uses the real application's public task API. No model/runtime ports or responses are replaced.
// Expectations stay in the audit record, outside all model inputs. No automatic plan approval.
const connectionPath=process.env.E2E_CONNECTION_FILE??'artifacts/live-workbench.json';
const connection=JSON.parse(await fs.readFile(connectionPath,'utf8'));
const matrix=JSON.parse(await fs.readFile('acceptance/platform-e2e/scenarios.json','utf8'));
const ids=process.argv.slice(2);
const scenarios=matrix.diagnosisScenarios.filter(s=>!ids.length||ids.includes(s.id));
if(!scenarios.length)throw Error('No matching scenarios');
const directory=path.resolve('artifacts','platform-e2e',randomUUID());
await fs.mkdir(directory,{recursive:true});
console.log(JSON.stringify({directory,scenarios:scenarios.map(s=>s.id)}));
async function api(route,body,contentType='application/json'){
  const response=await fetch(connection.url+route,{method:body?'POST':'GET',headers:{authorization:'Bearer '+connection.token,'content-type':contentType},
    ...(body?{body:Buffer.isBuffer(body)?body:JSON.stringify(body)}:{})});
  if(!response.ok)throw Error('HTTP '+response.status+': '+await response.text());
  return response.json();
}
for(const scenario of scenarios){
  const record={scenarioId:scenario.id,status:'RUNNING',startedAt:new Date().toISOString(),expectation:scenario.expectation};
  const save=()=>fs.writeFile(path.join(directory,scenario.id+'.json'),JSON.stringify(record,null,2));
  await save();
  try{
    const query=new URLSearchParams({name:'端到端诊断对照 '+scenario.id,goal:scenario.goal,target:scenario.target,inputKind:'skill_package'});
    let archive;
    if(scenario.sourceDirectory){
      const entries={};
      async function collect(directory,prefix=''){
        for(const entry of await fs.readdir(directory,{withFileTypes:true})){
          const name=prefix+entry.name;
          if(entry.isDirectory())await collect(path.join(directory,entry.name),name+'/');
          else if(entry.isFile())entries[name]=await fs.readFile(path.join(directory,entry.name));
          else throw Error('Fixture must contain only regular files and directories');
        }
      }
      await collect(scenario.sourceDirectory);
      archive=Buffer.from(zipSync(entries));
    }else archive=await fs.readFile(scenario.source);
    let task=await api('/api/migration-tasks/upload?'+query,archive,'application/zip');
    record.taskId=task.id;await save();
    task=await api('/api/migration-tasks/'+task.id+'/analysis',{key:randomUUID(),baseCandidateId:null});
    const deadline=Date.now()+30*60*1000;let lastProgress=0;
    while(task.attempts.at(-1)?.status==='RUNNING'){
      if(Date.now()>deadline)throw Error('Timed out waiting; task retained for inspection, not cancelled');
      await new Promise(resolve=>setTimeout(resolve,5000));
      task=await api('/api/migration-tasks/'+task.id);
      if(Date.now()-lastProgress>30000){console.log(JSON.stringify({scenario:scenario.id,taskId:task.id,status:task.attempts.at(-1)?.status}));lastProgress=Date.now();}
    }
    record.status=task.attempts.at(-1)?.status==='COMPLETED'?'AWAITING_SEMANTIC_REVIEW':'FAILED';
    record.analysis=task.analysis;record.attempt=task.attempts.at(-1);
  }catch(error){record.status='ERROR';record.error=error.message;}
  record.finishedAt=new Date().toISOString();await save();
  console.log(JSON.stringify({scenario:scenario.id,status:record.status,taskId:record.taskId}));
}
