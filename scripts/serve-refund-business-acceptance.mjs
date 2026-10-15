/** Explicit synthetic IT fixture for the frozen refund acceptance plan.
 * No model responses, migration records or verdicts. Never replace another
 * fixture's data under its existing address or relabel a failed evaluation.
 */
import {createServer} from 'node:http';
import {mkdtemp,writeFile,appendFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const orders={RF001:{status:'PENDING',paid_cents:10000,refunded_cents:0},
 RF002:{status:'SHIPPED',paid_cents:6000,refunded_cents:0}};
export const policy={allowed_statuses:['PENDING'],currency:'CNY'};
const work=await mkdtemp(path.join(os.tmpdir(),'refund-business-ui-'));
const server=createServer(async(req,res)=>{
 if(req.method==='GET'&&req.url==='/health'){
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ready',synthetic:true}));return;
 }
 // This public synthetic credential carries no user/account/API identity.
 if(req.headers.authorization!=='Bearer refund-acceptance-fixture'){
  res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:'UNAUTHORIZED'}));return;
 }
 let body='';for await(const chunk of req){body+=chunk;if(body.length>8192){res.writeHead(413);res.end();return;}}
 let payload;try{payload=JSON.parse(body||'{}')}catch{res.writeHead(400);res.end();return;}
 let result;
 if(req.method==='POST'&&req.url==='/business/order')result=orders[payload.order_id]??{error:'ORDER_NOT_FOUND'};
 else if(req.method==='POST'&&req.url==='/business/refund-policy')result=policy;
 else{res.writeHead(404);res.end();return;}
 await appendFile(path.join(work,'queries.jsonl'),JSON.stringify({operation:req.url,orderId:payload.order_id??null,result})+'\n');
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const info={url:`http://127.0.0.1:${server.address().port}`,work,purpose:'SYNTHETIC_IT_ONLY',orders,policy};
await writeFile(path.join(work,'service.json'),JSON.stringify(info,null,2));console.log(JSON.stringify(info));
let closed=false;async function close(){if(closed)return;closed=true;await new Promise(resolve=>server.close(resolve));}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
while(!closed){try{await readFile(path.join(work,'stop'));await close()}catch(error){if(error.code!=='ENOENT')throw error}if(!closed)await new Promise(resolve=>setTimeout(resolve,500));}
