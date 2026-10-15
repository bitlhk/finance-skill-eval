/** Real A2 regression for source-owned versus host-owned capability classification. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {analyzeWithAgent,toProjectInspection} from '../dist/migration/infrastructure/migration-agent.js';
import {stableToolId} from '../dist/migration/domain/migration-model.js';
import {runtimeBuildRequirements} from '../dist/migration/domain/migration-harness.js';

process.env.FINANCE_EVAL_MIGRATION_AGENT='on';
const root=process.cwd(),source=path.join(root,'acceptance/capability-migration/payment-exception/source');
const paths=['SKILL.md','references/native-files.md'];
const files=Object.fromEntries(await Promise.all(paths.map(async name=>[name,new Uint8Array(await readFile(path.join(source,name)))])));
const text=Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,new TextDecoder().decode(bytes)]));
const digest=createHash('sha256').update(JSON.stringify(text)).digest('hex');
const shared={inputSchema:{type:'object',properties:{path:{type:'string'},scope:{enum:['workspace','skill']}},required:['path'],additionalProperties:false},
  errorSchema:{type:'object',properties:{status:{const:'unavailable'},error:{const:'TOOL_EXECUTION_FAILED'}},required:['status','error']}};
const constraints={permissions:['workspace.read','skill.read'],sideEffects:'read',isolation:'per_case_workspace'};
const capability=(name,outputSchema,semantics)=>({capabilityId:`package.${name}`,name,
  contract:{...shared,outputSchema,semantics},constraints});
const targetRuntime={schemaVersion:'finance.skill-eval.runtime-capabilities.v1',runtime:{type:'openjiuwen',version:'test'},
  models:[{modelId:'test',upstreamModelId:'test'}],defaultModelId:'test',
  nativeToolNames:['read_file','list_files'],nativeCapabilities:[
    capability('read_file',{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']},
      'Read one UTF-8 file in the selected case or installed Skill scope; reject traversal and files above 256 KiB.'),
    capability('list_files',{type:'object',properties:{path:{type:'string'},files:{type:'array',items:{type:'string'}}},required:['path','files']},
      'List sorted immediate regular files under the selected case or installed Skill scope; reject traversal, symlinks and directories above 256 entries.'),
  ],features:{streaming:true,asyncLaunch:true,packagedMcp:true,externalMcp:true,inlineSecrets:true},
  limits:{maxArchiveBytes:100000,maxFiles:100,maxTimeoutMs:900000,maxConcurrentInstances:1}};
const runtime=JSON.parse(await readFile(path.join(root,'.runtime.local.json'),'utf8'));
const [modelId,model]=Object.entries(runtime.models).find(([,value])=>value.enabled!==false);
const result=await analyzeWithAgent({assetDigest:digest,runId:'payment-classification-regression',files,targetRuntime},
  {projectRoot:root,modelId,providerId:model.providerId??'service-execution',timeoutMs:900000});
assert(result?.status==='PRODUCED',`A2 did not produce a diagnosis: ${result?.status}`);
const inspection=toProjectInspection(result.payload,'payment-regression',digest,stableToolId,result.scanner,text);
const requirements=runtimeBuildRequirements(inspection);
const names='requiredCapabilities' in (requirements??{})?requirements.requiredCapabilities.map(item=>item.name):[];
const passed=names.includes('request_approval')&&!inspection.tools.some(item=>item.name==='request_approval');
console.log(JSON.stringify({passed,requiredCapabilities:names,businessTools:inspection.tools.map(item=>item.name),
  correctionAttempts:result.outputCorrectionAttempts??0}));
assert(passed,'A2 did not retain the host-owned approval requirement');
