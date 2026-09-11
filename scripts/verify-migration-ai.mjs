import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync,strToU8 } from 'fflate';
import { SkillStore } from '../dist/service/skill-store.js';
import { MigrationDiagnostics } from '../dist/service/migration-diagnostics.js';
import { configuredModelRole } from '../dist/service/config.js';

// Synthetic source only. Exercise the real configured model without customer material.
const role=configuredModelRole('ANALYZER');
if(!role.configured)throw new Error('ANALYZER_NOT_CONFIGURED');
const data=await mkdtemp(path.join(os.tmpdir(),'migration-ai-'));
const skills=new SkillStore(data);await skills.initialize();
const asset=await skills.uploadZip(Buffer.from(zipSync({'SKILL.md':strToU8('---\nname: synthetic-ai-diagnosis\nversion: 1.0.0\n---\nDescribe supplied facts; missing is not zero.'),
  'tool.py':strToU8('from agentscope.tool import ToolResponse\ndef read():\n    return ToolResponse(content=[])\n')})));
const diagnostics=new MigrationDiagnostics(process.cwd(),data,skills,()=>role);
await diagnostics.diagnose(asset);
const file=path.join(data,'migration-diagnostics',asset.artifactSha256+'.json');
let result;const deadline=Date.now()+190000;
do{await new Promise(r=>setTimeout(r,1000));result=JSON.parse(await readFile(file,'utf8'));}while(result.ai.status==='RUNNING'&&Date.now()<deadline);
const report={mode:'REAL_MODEL_SYNTHETIC_SOURCE',model:role.model.modelId,status:result.ai.status,sourceDigest:asset.artifactSha256,
  suggestions:result.ai.suggestions?.length??0,findings:result.findings.length,customerSourceSent:false,nativeRuntimeExecuted:false,dataDirectory:data};
if(process.argv[2])await writeFile(path.resolve(process.argv[2]),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));assert.equal(result.ai.status,'COMPLETE',result.ai.error);
