import {createLiveProjectLauncher} from './verify-project-process-live.mjs';
import {createEvaluationService} from '../dist/service/server.js';
import {zipSync} from 'fflate';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';

// Real application composition: no Agent/Judge/Runtime port replacement.
const prior=process.argv.includes('--resume')?JSON.parse(await readFile('artifacts/live-workbench.json','utf8')):null;
const launcher=await createLiveProjectLauncher(process.argv[2],{port:prior?Number(new URL(prior.environment.baseUrl).port):0,
  businessPort:prior?.businessUrl?Number(new URL(prior.businessUrl).port):0});
const data=prior?.data??path.join(launcher.folder,'platform');
await mkdir(data,{recursive:true});
const token='local-live-project-workbench';
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:data,
  publicDirectory:path.resolve('web-dist'),accessToken:token,publicDemo:false,workspaceMode:'single'});
app.log.level='error';
const url=await app.listen({host:'127.0.0.1',port:prior?Number(new URL(prior.url).port):0});
const auth={authorization:'Bearer '+token};
const response=prior?null:await app.inject({method:'POST',url:'/api/environments',headers:auth,
  payload:{name:'真实 AgentScope 工程（隔离数据）',type:'runtime_launcher',runtimeType:'agentscope',baseUrl:launcher.url}});
if(response&&response.statusCode!==200)throw Error(response.body);
const archivePath=path.join(launcher.folder,'agent-project.zip');
await writeFile(archivePath,Buffer.from(zipSync(Object.fromEntries(Object.entries(launcher.files).map(([name,value])=>[name,Buffer.from(value,'base64')])))));
const connection={url,token,data,archivePath,environment:prior?.environment??response.json(),modelId:launcher.modelId,businessUrl:launcher.businessUrl};
await writeFile(path.resolve('artifacts/live-workbench.json'),JSON.stringify(connection,null,2));
console.log(JSON.stringify({url,archivePath,data,modelId:launcher.modelId}));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{void app.close().then(()=>launcher.host.close()).then(()=>process.exit());});
