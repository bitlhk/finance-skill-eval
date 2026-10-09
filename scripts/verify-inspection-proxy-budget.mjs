/** Real two-hop Nginx timing probe; synthetic responses, no SSO/model/bank calls. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chmod,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createServer as createSocket} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const output=process.argv[2];assert(output,'Provide a new evidence directory');
await mkdir(output,{mode:0o700});
const root=await mkdtemp(path.join(tmpdir(),'eval-inspection-proxy-'));await chmod(root,0o700);
const report={status:'FAIL',scope:'SCALED_TWO_HOP_TIMEOUT_NOT_SSO_OR_MODEL_ACCEPTANCE',
  cases:[],backendCalls:0,productionChanged:false,cleanup:false};
const backend=createServer(async(_request,response)=>{
  report.backendCalls++;
  await delay(1400);
  response.writeHead(409,{'content-type':'application/json'});
  response.end(JSON.stringify({error:'SYNTHETIC_ANALYSIS_DEADLINE'}));
});
await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
const port=backend.address().port;
let child;
async function unusedPort(){
  const server=createSocket();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const selected=server.address().port;await new Promise(resolve=>server.close(resolve));return selected;
}
async function stop(){
  if(!child)return;
  const process=child;child=undefined;
  if(process.exitCode!==null||process.signalCode!==null)return;
  const closed=once(process,'exit');process.kill('SIGTERM');
  const timer=setTimeout(()=>process.kill('SIGKILL'),3000);
  try{await closed;}finally{clearTimeout(timer);}
}
try{
  for(const [name,edgeSeconds,originSeconds,expected] of [
    ['short-origin',3,1,504],['short-edge',1,3,504],['both-cover-terminal',3,3,409],
  ]){
    const edge=await unusedPort();let origin=await unusedPort();
    while(origin===edge)origin=await unusedPort();
    const directory=path.join(root,name);await mkdir(directory);
    const configuration=`pid ${directory}/nginx.pid;
error_log ${directory}/error.log;
events { worker_connections 32; }
http {
 access_log off;
 proxy_temp_path ${directory}/proxy;
 server { listen 127.0.0.1:${edge};
   location = /health { return 204; }
   location / { proxy_pass http://127.0.0.1:${origin}; proxy_read_timeout ${edgeSeconds}s; proxy_buffering off; }
 }
 server { listen 127.0.0.1:${origin};
   location / { proxy_pass http://127.0.0.1:${port}; proxy_read_timeout ${originSeconds}s; proxy_buffering off; }
 }
}`;
    const config=path.join(directory,'nginx.conf');await writeFile(config,configuration,{mode:0o600});
    child=spawn(process.env.NGINX_BIN??'/usr/sbin/nginx',['-p',directory+'/', '-c',config,'-g','daemon off;'],{stdio:'ignore'});
    let spawnError;child.on('error',error=>{spawnError=error;});
    let ready=false;
    for(let attempt=0;attempt<50;attempt++){
      if(spawnError)throw spawnError;
      assert.equal(child.exitCode,null,'Isolated Nginx exited before readiness');
      try{ready=(await fetch(`http://127.0.0.1:${edge}/health`,{signal:AbortSignal.timeout(500)})).status===204;}catch{}
      if(ready)break;await delay(50);
    }
    assert(ready,'Isolated Nginx not ready');
    const started=performance.now();
    const response=await fetch(`http://127.0.0.1:${edge}/api/migrations/synthetic/inspect`,{method:'POST',signal:AbortSignal.timeout(5000)});
    const text=await response.text();
    report.cases.push({name,edgeSeconds,originSeconds,status:response.status,elapsedMs:performance.now()-started});
    assert.equal(response.status,expected);
    if(expected===409)assert.equal(JSON.parse(text).error,'SYNTHETIC_ANALYSIS_DEADLINE');
    await stop();
  }
  assert.equal(report.backendCalls,3,'No automatic analysis retry');
  report.status='PASS';
}catch(error){report.error=error.message;process.exitCode=1;}
finally{
  await stop();backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));
  await rm(root,{recursive:true,force:true});report.cleanup=true;
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify(report));
}
