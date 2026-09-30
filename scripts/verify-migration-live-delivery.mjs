import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {zipSync,strToU8} from 'fflate';
import {createEvaluationService} from '../dist/service/server.js';
import {analyzeWithAgent,implementWithAgent} from '../dist/migration/infrastructure/migration-agent.js';
import {SkillStore} from '../dist/service/skill-store.js';
import {LocalWorker} from '../dist/service/local-worker.js';
import {pythonCommand} from '../dist/service/technical-validation.js';

const regenerate=process.argv[2]==='--regenerate';
const replay=process.argv[2]==='--replay'||regenerate?path.resolve(process.argv[3]):undefined;
const mode=regenerate?'REAL_A4_FASTMCP_WITH_SAVED_A2':replay?'REPLAY_REAL_A2_A4_OUTPUT':'LIVE_A2_A4';
const root=process.cwd(),output=path.join(root,'reports',`migration-${regenerate?'fastmcp-delivery':replay?'delivery-repack':'live-delivery'}-${new Date().toISOString().replaceAll(':','-')}`);
await mkdir(output,{recursive:true});
const config=JSON.parse(await readFile(path.join(root,'.runtime.local.json'),'utf8'));
const [modelId,model]=Object.entries(config.models).find(([,m])=>m.enabled!==false);
const options={projectRoot:root,modelId,providerId:model.providerId??'service-execution',timeoutMs:1_200_000};
process.env.FINANCE_EVAL_MIGRATION_AGENT='on';process.env.FINANCE_EVAL_AGENT_ATTEMPTS='1';
const calls=[],checks=[];let stage='SETUP',app;
const backend=createServer((request,response)=>{
 const url=new URL(request.url,'http://localhost');
 const accepted=url.pathname==='/balance'&&request.headers.authorization==='Bearer live-test-credential'&&request.headers['x-tenant-id']==='test-tenant';
 calls.push({path:url.pathname,accountId:url.searchParams.get('account'),credentialMatched:request.headers.authorization==='Bearer live-test-credential',tenantMatched:request.headers['x-tenant-id']==='test-tenant'});
 response.writeHead(accepted?200:403,{'content-type':'application/json'});
 response.end(JSON.stringify(accepted?{account_id:url.searchParams.get('account'),balance:1000,currency:'CNY'}:{error:'forbidden'}));
});await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
const endpoint=`http://127.0.0.1:${backend.address().port}/balance`;
if(replay)process.env.BALANCE_SERVICE_URL=regenerate||process.argv.includes('--backend-url=endpoint')?endpoint:endpoint.replace(/\/balance$/u,'');
const source={
 'SKILL.md':`---\nname: live-migration-delivery\ndescription: 查询企业余额并计算服务费，用于真实迁移验收\nversion: 1.0.0\n---\n\n# 企业余额和服务费\n\n查询余额时调用 balance，输入是 account_id 字符串，例如 {"account_id":"A1"}，输出是 {"account_id":"A1","balance":1000,"currency":"CNY"}。余额工具的 Credential 和 tenant_id 来自原 Runtime 的执行上下文，不属于用户业务参数。Credential 是 string，原样用于 Authorization；tenant_id 是 string，用于 X-Tenant-Id。\n\n计算服务费时执行 quote_fee，业务输入例如 {"amount":100}，结果为 {"fee":2.5}。费率保存在 quote_fee.py 同目录的 rates.json。先查询余额，再按用户给的金额计算服务费。不能执行交易。\n`,
 'tools/legacy_runtime.py':`from contextvars import ContextVar\nfrom dataclasses import dataclass\n\n@dataclass\nclass ExecutionContext:\n    credential: str\n    tenant_id: str\n\nexecution_context = ContextVar("execution_context")\n`,
 'tools/balance.py':`import json\nfrom urllib.request import Request, urlopen\nfrom urllib.parse import quote\nfrom legacy_runtime import execution_context\n\ndef balance(account_id: str) -> dict:\n    context = execution_context.get()\n    credential: str = context.credential\n    tenant_id: str = context.tenant_id\n    request = Request(${JSON.stringify(endpoint)} + "?account=" + quote(account_id), headers={"Authorization": credential, "X-Tenant-Id": tenant_id})\n    with urlopen(request, timeout=5) as response:\n        return json.load(response)\n`,
 'scripts/quote_fee.py':`import json\nimport sys\nfrom pathlib import Path\nfrom decimal import Decimal\n\ndef quote_fee(amount: float) -> dict:\n    rates = json.loads(Path(__file__).with_name("rates.json").read_text())\n    fee = Decimal(str(amount)) * Decimal(str(rates["rate"]))\n    return {"fee": float(fee)}\n\nif __name__ == "__main__":\n    payload = json.load(sys.stdin)\n    json.dump(quote_fee(payload["amount"]), sys.stdout)\n`,
 'scripts/rates.json':'{"rate":0.025}\n',
};
await writeFile(path.join(output,'source.zip'),Buffer.from(zipSync(Object.fromEntries(Object.entries(source).map(([name,text])=>[name,strToU8(text)])))));
if(replay)await writeFile(path.join(output,'source.zip'),await readFile(path.join(replay,'source.zip')));
const safe=value=>{let text=JSON.stringify(value,null,2);for(const secret of [model.apiKey,'Bearer live-test-credential'])if(secret)text=text.replaceAll(secret,'[redacted]');return text};
const save=(name,value)=>writeFile(path.join(output,name),safe(value));
const liveAnalyze=async input=>{console.log(replay?'REPLAY A2':'LIVE A2 START');const result=replay?JSON.parse(await readFile(path.join(replay,'a2-result.json'),'utf8')):await analyzeWithAgent(input,options);await save('a2-result.json',result);console.log(`A2 END ${result?.status}`);return result};
const liveImplement=async input=>{await save('a4-request-contract.json',{decisions:input.decisions,contract:input.contract,deliveryContract:input.deliveryContract});console.log(replay&&!regenerate?'REPLAY A4':'LIVE A4 START');const result=replay&&!regenerate?JSON.parse(await readFile(path.join(replay,'a4-result.json'),'utf8')):await implementWithAgent(input,options);await save('a4-result.json',result);console.log(`A4 END ${result?.status}`);return result};
try{
 app=await createEvaluationService({rootDirectory:root,dataDirectory:path.join(output,'service-data'),publicDemo:false,accessToken:'local-live-migration',migrationAnalyzer:liveAnalyze,migrationImplementer:liveImplement});
 const headers={authorization:'Bearer local-live-migration'};
 async function api(method,url,payload,extra={}){
  const response=await app.inject({method,url,headers:{...headers,...extra},...(payload!==undefined?{payload}:{})});
  if(response.statusCode>=400)throw Error(`${method} ${url}: HTTP ${response.statusCode}: ${response.body.slice(0,2000)}`);
  return response.json();
 }
 stage='IMPORT';const asset=await api('POST','/api/skills/upload',await readFile(path.join(output,'source.zip')),{'content-type':'application/zip'});
 const project=await api('POST','/api/migrations',{sourceAssetId:asset.assetId,name:'真实模型交付验证'}),url=`/api/migrations/${project.id}`;
 stage='DIAGNOSIS';const inspection=await api('POST',url+'/inspect');await save('inspection.json',inspection);
 assert.equal(inspection.dependencyAnalysis?.status,'COMPLETE',`诊断未闭环: ${safe(inspection.dependencyAnalysis)}`);
 const balance=inspection.tools.find(t=>t.name==='balance'),fee=inspection.tools.find(t=>t.name==='quote_fee');assert(balance&&fee,'A2 未识别两个目标');
 checks.push(replay?'复用已保存的真实 A2 依赖诊断':'真实 A2 完成依赖诊断');
 for(const tool of inspection.tools){assert(['balance','quote_fee'].includes(tool.name),`意外工具 ${tool.name}`);await api('PUT',url+`/tools/${tool.toolId}/decision`,{baseAssetId:asset.assetId,form:tool.name==='balance'?'MCP':'SCRIPT',language:'python'})}
 stage='GENERATION';const generated=await api('POST',url+'/generate',{baseAssetId:asset.assetId});await save('generated-project.json',generated);
 assert(generated.candidate);checks.push('真实 A4 完成交付且平台一致性校验通过');
 const archive=await new SkillStore(path.join(output,'service-data')).readArchive(generated.candidate.assetId);
 if(replay&&!regenerate&&!process.argv.includes('--backend-url=endpoint')){
  assert(archive['skill/scripts/quote_fee/quote_fee.py']);assert(archive['skill/scripts/quote_fee/rates.json']);
  assert(!archive['skill/scripts/rates.json']);assert(!Object.keys(archive).some(name=>name.endsWith('legacy_runtime.py')));
  const readme=Buffer.from(archive['README.md']).toString();assert(readme.includes('skill/scripts/quote_fee/quote_fee.py'));assert(!readme.includes('`scripts/quote_fee.py`'));
  checks.push('交付入口、资源去重、Runtime 遗留清理及 README 路径检查通过');
 }
 if(regenerate||process.argv.includes('--backend-url=endpoint')){
  const generation=generated.portableGenerations.find(g=>g.toolId===balance.toolId);
  const service=Buffer.from(archive[generation.entrypoint]).toString();
  assert.match(service,/from fastmcp import FastMCP/u);assert(!service.includes('mcp.server.lowlevel'));
  assert(generation.files.some(name=>Buffer.from(archive[name]).toString().includes('fastmcp==2.14.7')));
  checks.push('交付服务使用独立 FastMCP 2.14.7');
 }
 await mkdir(path.join(output,'candidate'),{recursive:true});for(const [name,bytes] of Object.entries(archive)){const target=path.join(output,'candidate',name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes)}
 const template=JSON.parse(Buffer.from(archive['runtime-tool-config.template.json']).toString());await save('runtime-template.json',template);assert.equal(template.unresolved.length,0);checks.push('无真实值的 Runtime 配置模板生成');
 stage='TEST_CONFIGURATION';let revision=0;
 for(const dep of inspection.dependencyAnalysis.dependencies.filter(d=>d.owner==='RUNTIME'&&d.action==='INJECT')){
  assert.equal(dep.binding?.kind,'HTTP_HEADER');const header=dep.binding.name.toLowerCase();const value=header==='authorization'?'Bearer live-test-credential':header==='x-tenant-id'?'test-tenant':undefined;
  assert.notEqual(value,undefined,`意外依赖 ${dep.name} ${header}`);await api('PUT',url+`/runtime-configuration/${dep.id}`,{revision:revision++,value});
 }
 stage='TECHNICAL_MCP';const mcp=await api('POST',url+'/validate/technical',{baseAssetId:generated.candidate.assetId,toolId:balance.toolId,arguments:{account_id:'A1'}});await save('mcp-validation.json',mcp);assert.equal(mcp.status,'PASSED',safe(mcp));assert(calls.some(c=>c.accountId==='A1'&&c.credentialMatched&&c.tenantMatched));checks.push('生成的 MCP 服务真实调用业务接口，Credential 和租户 Header 正确');
 stage='TECHNICAL_SCRIPT';const script=await api('POST',url+'/validate/technical',{baseAssetId:generated.candidate.assetId,toolId:fee.toolId,request:{amount:100}});await save('script-validation.json',script);assert.equal(script.status,'PASSED',safe(script));
 const entry=generated.portableGenerations.find(g=>g.toolId===fee.toolId).entrypoint,command=pythonCommand(archive,entry);
 const result=await new LocalWorker().run({requestId:'live-fee-result',...command,files:Object.entries(archive).map(([path,content])=>({path,content})),stdin:'{"amount":100}',separateWorkspace:true,timeoutMs:60000});assert.equal(result.exitCode,0,result.stderr);assert.equal(JSON.parse(result.stdout).fee,2.5);checks.push('生成的 Script 在独立 workspace 执行并读取包资源，结果 2.5 正确');
 stage='EXPORT';const download=await app.inject({method:'GET',url:url+'/export',headers});assert.equal(download.statusCode,200);await writeFile(path.join(output,'candidate-unverified.zip'),download.rawPayload);
 await save('result.json',{status:'PASSED',mode,...(replay?{originalReport:replay}:{}),modelId,upstreamModelId:model.upstreamModelId,checks,calls,projectId:project.id,candidateAssetId:generated.candidate.assetId});console.log('DELIVERY PASSED '+output);
}catch(error){await save('result.json',{status:'FAILED',stage,mode,modelId,upstreamModelId:model.upstreamModelId,checks,calls,error:String(error)});console.error(`LIVE DELIVERY FAILED ${stage} ${String(error).slice(0,2500)} REPORT ${output}`);process.exitCode=1}
finally{await app?.close();await new Promise(resolve=>backend.close(resolve))}
