/** Opt-in readonly source analysis. No uploaded code, bank tools, or generation. */
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {parse as yaml} from 'yaml';
import {createEvaluationService} from '../dist/service/server.js';
import {analyzeWithAgent} from '../dist/migration/infrastructure/migration-agent.js';

assert.equal(process.env.FINANCE_EVAL_LIVE_ANALYSIS_APPROVED,'true','Explicit approved source/model scope required');
const [sourcePath,outputPath]=process.argv.slice(2);
assert(sourcePath&&outputPath);
const output=path.resolve(outputPath);await mkdir(output,{recursive:true,mode:0o700});
const source=JSON.parse(await readFile(sourcePath,'utf8'));
const archive=Buffer.from(source.archiveBase64,'base64'),files=unzipSync(archive);
assert(Object.keys(files).length<=16&&archive.length<=128*1024);
assert(Object.keys(files).every(name=>/^(SKILL\.md|references\/[a-zA-Z0-9_-]+\.(md|txt))$/u.test(name)));
const expected=yaml(Buffer.from(files['SKILL.md']).toString().split('---')[1])['allowed-tools'];
assert(Array.isArray(expected));
const modelId=process.env.FINANCE_EVAL_AGENT_MODEL_ID;assert(modelId);
process.env.FINANCE_EVAL_MIGRATION_AGENT='on';
const report={status:'FAIL',scope:'REAL_ANALYSIS_OF_APPROVED_READONLY_METHOD',modelId,
  archiveSha256:createHash('sha256').update(archive).digest('hex'),expectedTools:expected,
  nativeExecution:'NOT_RUN',professionalQuality:'NOT_EVALUATED',productionChanged:false};
const token=randomBytes(32).toString('hex');let app;
try{
  app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:path.join(output,'data'),
    accessToken:token,publicDemo:false,managedWorkspace:true,
    migrationAnalyzer:async input=>{
      const result=await analyzeWithAgent(input,{projectRoot:process.cwd(),modelId,maxIterations:12,maxTokens:32000,
        modelTimeoutMs:120000,timeoutMs:600000});
      await writeFile(path.join(output,'analysis.json'),JSON.stringify(result,null,2),{mode:0o600});
      return result;
    },migrationImplementer:async()=>{throw Error('Uploaded code generation not permitted in this probe');}});
  app.log.level='error';
  async function request(method,url,payload,contentType){
    const response=await app.inject({method,url,headers:{authorization:'Bearer '+token,
      ...(contentType?{'content-type':contentType}:{})},payload});
    assert(response.statusCode<400,`${url}: HTTP ${response.statusCode}`);return response.json();
  }
  const asset=await request('POST','/api/skills/upload',archive,'application/zip');
  const project=await request('POST','/api/migrations',{sourceAssetId:asset.assetId,name:'Approved readonly live analysis'});
  const inspection=await request('POST',`/api/migrations/${project.id}/inspect`,{});
  await writeFile(path.join(output,'inspection.json'),JSON.stringify(inspection,null,2),{mode:0o600});
  report.analysisStatus=inspection.dependencyAnalysis?.status;
  report.actualTools=inspection.tools.map(tool=>tool.name);
  assert.deepEqual([...report.actualTools].sort(),[...expected].sort(),'Actual analysis must identify only declared business tools');
  assert.equal(report.analysisStatus,'COMPLETE','No unverified dependency completion');
  assert(inspection.tools.every(tool=>tool.evidence?.length>0),'Each tool needs located source evidence');
  report.status='PASS';
}catch(error){report.failure=String(error.message).slice(0,1000);process.exitCode=1;}
finally{
  await app?.close();
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report));
}
