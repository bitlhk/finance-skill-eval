/** Synthetic IT service only. No model replies, migration records or verdicts. */
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,appendFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ledgerFixture} from '../acceptance/capability-migration/manifest.mjs';

const work=await mkdtemp(path.join(os.tmpdir(),'ledger-business-ui-'));
const server=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/health'){
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({status:'ready',synthetic:true}));return;
  }
  let id;
  try{if(req.method==='GET'&&req.url?.startsWith('/ledger/'))id=decodeURIComponent(req.url.slice(8));}catch{}
  const ledger=ledgerFixture(id);
  await appendFile(path.join(work,'queries.jsonl'),JSON.stringify({customerId:id??null,found:!!ledger})+'\n');
  res.writeHead(ledger?200:404,{'content-type':'application/json'});
  res.end(JSON.stringify(ledger??{error:'NOT_FOUND'}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const info={url:`http://127.0.0.1:${server.address().port}`,work,purpose:'SYNTHETIC_IT_ONLY'};
await writeFile(path.join(work,'service.json'),JSON.stringify(info,null,2));
console.log(JSON.stringify(info));
let closed=false;
async function close(){if(closed)return;closed=true;await new Promise(resolve=>server.close(resolve));}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
while(!closed){
  try{await readFile(path.join(work,'stop'));await close();}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!closed)await new Promise(resolve=>setTimeout(resolve,500));
}
