import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {inspectRuntimeIntake} from '../dist/evaluation/application/runtime-intake.js';
import {runtimeLauncherBaseUrlSchema} from '../dist/shared/contracts/runtime-launcher.js';

const {values}=parseArgs({options:{capabilities:{type:'string'},url:{type:'string'},require:{type:'string'},evidence:{type:'string'},'run-id':{type:'string'},'case-id':{type:'string'},side:{type:'string'}}});
try{
  if(Boolean(values.capabilities)===Boolean(values.url))throw Error('Provide exactly one of --capabilities or --url');
  let capabilities;
  if(values.url){
    const url=new URL('v1/runtime-capabilities',runtimeLauncherBaseUrlSchema.parse(values.url));
    const token=process.env.RUNTIME_CHECK_TOKEN;
    const response=await fetch(url,{headers:token?{authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!response.ok)throw Error('Capabilities HTTP '+response.status);
    const reader=response.body.getReader();const chunks=[];let size=0;
    try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>262144){await reader.cancel();throw Error('Capabilities response too large');}chunks.push(chunk.value);}}finally{reader.releaseLock();}
    capabilities=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }else capabilities=JSON.parse(await readFile(values.capabilities,'utf8'));
  const result=inspectRuntimeIntake({capabilities,features:values.require?.split(',').filter(Boolean),
    ...(values.evidence?{evidence:JSON.parse(await readFile(values.evidence,'utf8'))}:{}),
    ...(values['run-id']&&values['case-id']&&values.side?{identity:{runId:values['run-id'],caseId:values['case-id'],side:values.side}}:{})});
  console.log(JSON.stringify(result,null,2));if(!result.compatible||result.execution==='INCOMPLETE')process.exitCode=1;
}catch(error){console.error(JSON.stringify({compatible:false,error:error.message}));process.exitCode=1;}
