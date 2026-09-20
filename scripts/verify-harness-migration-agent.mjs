/** Live A4 model -> packaged original Harness -> pinned Runtime plugin loader. */
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {runMigrationAgent} from '../dist/service/migration-agent.js';
import {harnessDeliveryContract,toGeneratedHarnessPlugins} from '../dist/service/migration-harness.js';
import {generatePortableCandidate} from '../dist/service/portable-candidate.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(await readFile(path.join(root,'.runtime.local.json'),'utf8'));
const [modelId]=Object.entries(config.models).find(([,v])=>v.enabled!==false);
const existing=process.argv[2];
const report=existing?path.resolve(root,existing):path.join(root,'reports','harness-migration-live-'+new Date().toISOString().replace(/[:.]/gu,'-'));
assert.ok(report.startsWith(path.join(root,'reports')+path.sep),'Report must stay inside reports');
await mkdir(report,{recursive:true});
const secrets=Object.values(config.models).map(v=>v.apiKey).filter(Boolean);
async function save(name,value){
  let text=JSON.stringify(value,null,2);
  for(const secret of secrets)text=text.replaceAll(secret,'[redacted]');
  await writeFile(path.join(report,name),text);
}
const inputSchema={type:'object',properties:{path:{type:'string'}},required:['path']};
const source='from pathlib import Path\n\ndef read_document(path: str) -> dict:\n    """Original harness: read UTF-8 text; propagate original file errors."""\n    return {"content": Path(path).read_text(encoding="utf-8"), "implementation": "ORIGINAL_HARNESS_7F31"}\n';
const texts={
  'SKILL.md':'---\nname: document-harness-demo\ndescription: Read a document using the original Runtime Harness.\n---\nCall read_document with path="sample.txt" and return its result. Keep the tool name read_document.\n',
  'tools/original.py':source,
  'tools/registration.json':JSON.stringify({runtime:'original-runtime',toolName:'read_document',implementation:'original.read_document',inputSchema}),
  'sample.txt':'迁移前后的内容必须一致。',
};
const archive=Object.fromEntries(Object.entries(texts).map(([p,s])=>[p,Buffer.from(s)]));
const digest=createHash('sha256').update(JSON.stringify(texts)).digest('hex');
const capability={name:'read_document',owner:'RUNTIME_HARNESS',migrationAction:'DO_NOT_MIGRATE',blocking:false,
  reason:'原 Runtime 注册的文件读取能力，只适配注册方式，不绑定为 Skill 业务工具。',
  usageContract:'read_document(path:string)->{content:string,implementation:string}; UTF-8; propagate file errors. Preserve original implementation.',
  targetCapability:null,testAvailability:'UNCHECKED',consumerTools:[],
  evidence:[{path:'tools/original.py',line:3,kind:'SOURCE',detail:'def read_document(path: str) -> dict:'},{path:'tools/registration.json',line:1,kind:'SOURCE',detail:'Original Runtime registration and input schema'}]};
const inspection={tools:[],runtimeCapabilities:[capability]};
const expected={content:texts['sample.txt'],implementation:'ORIGINAL_HARNESS_7F31'};
const contract={form:'HARNESS',language:'python',toolName:'read_document',expectedToolNames:['read_document'],inputSchema,
  sampleInput:{path:'sample.txt'},sampleOutput:expected};
const workspace=await mkdtemp(path.join(os.tmpdir(),'live-harness-migration-'));
try{
  console.log(existing?'Reverifying existing live model artifact; no regeneration.':'Running live A4 migration model: '+modelId);
  const result=existing?JSON.parse(await readFile(path.join(report,'agent-result.json'),'utf8')):await runMigrationAgent('A4',{assetDigest:digest,runId:'live-harness',files:Object.fromEntries(Object.entries(archive).map(([p,b])=>[p,b.toString('base64')])),
    decisions:[],tools:[],contract:{'harness:read_document':contract},
    deliveryContract:{harness:{...harnessDeliveryContract(inspection),sourceContracts:{read_document:contract}}}},
    {projectRoot:root,modelId,maxIterations:50,maxTokens:32000,modelTimeoutMs:180000,timeoutMs:900000});
  await save('agent-result.json',result);
  assert.equal(result.status,'PRODUCED',result.run?.error);
  const plugins=toGeneratedHarnessPlugins(result.payload.judgement,result.payload.files??{},inspection);
  assert.equal(plugins.length,1);
  assert.equal(plugins[0].callExecuted,true,'A4 must actually invoke the provided sample');
  const candidate=generatePortableCandidate({archive,base:{skillFile:'SKILL.md',skillId:'document-harness-demo'},inspection,decisions:[],version:'2.0.0',harnessPlugins:plugins});
  for(const [relative,bytes] of Object.entries(candidate.files)){
    const destination=path.join(workspace,relative);await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,bytes);
    const delivery=path.join(report,'candidate',relative);await mkdir(path.dirname(delivery),{recursive:true});await writeFile(delivery,bytes);
  }
  // This is user input in the evaluation workspace, separate from Skill resources.
  await writeFile(path.join(workspace,'sample.txt'),texts['sample.txt']);
  await save('workspace-fixture.json',{path:'sample.txt',content:texts['sample.txt'],purpose:'User document supplied by the test case, separate from the Skill package.'});
  async function verify(entry){
    const child=spawn(path.join(root,'.venv-openjiuwen/Scripts/python.exe'),['-B',path.join(root,'integrations/openjiuwen/harness_contract.py'),JSON.stringify(entry)],{cwd:workspace,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1'}});
    let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
    const timer=setTimeout(()=>child.kill(),90000);
    const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});clearTimeout(timer);
    const line=output.split(/\r?\n/u).findLast(s=>s.startsWith('HARNESS_CONTRACT_JSON='));
    assert.equal(exit,0,errors.slice(-1000));assert.ok(line,'Runtime verification returned no result');
    return JSON.parse(line.slice('HARNESS_CONTRACT_JSON='.length));
  }
  console.log('A4 produced plugin. Verifying packaged artifact in pinned Runtime.');
  const verification=await verify({...contract,manifestPath:plugins[0].manifestPath});
  await save('runtime-verification.json',verification);
  assert.equal(verification.passed,true,JSON.stringify(verification));
  assert.deepEqual(verification.produced,expected);
  const missing=await verify({...contract,sampleInput:{path:'missing-file.txt'},sampleOutput:undefined,manifestPath:plugins[0].manifestPath});
  await save('runtime-missing-file.json',missing);
  assert.equal(missing.passed,false,'Original missing-file exception must propagate');
  assert.match(missing.error,/FileNotFoundError/u);
  const summary={passed:true,modelId:result.run?.modelId??modelId,runtimeVersion:'0.1.17.post1',agentElapsedMs:result.run?.elapsedMs,
    toolNames:verification.observedToolNames,checks:['Live A4 model produced plugin','Real compile and contract-call evidence','Separate implementation and adapter packaging','Original tool name and exact input schema','Original output equality','Original missing-file exception'],report};
  await save('result.json',summary);console.log(JSON.stringify(summary));
}catch(error){await save('result.json',{passed:false,modelId,error:String(error),report});console.error(String(error));process.exitCode=1;}
finally{await rm(workspace,{recursive:true,force:true});}
