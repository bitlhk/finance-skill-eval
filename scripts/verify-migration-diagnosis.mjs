import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { createEvaluationService } from '../dist/service/server.js';

// Private evidence only. Uploaded Python files are NEVER imported or executed.
const [input,outArg]=process.argv.slice(2);
if(!input||!outArg)throw new Error('Usage: node scripts/verify-migration-diagnosis.mjs private.zip private-new-output');
const out=path.resolve(outArg);await mkdir(out,{mode:0o700});
const original=await readFile(input),files=unzipSync(original),source=Object.fromEntries(Object.entries(files).map(([p,b])=>[p,Buffer.from(b).toString('utf8')]));
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:path.join(out,'data'),accessToken:'isolated-local-probe',publicDemo:false});
const headers={authorization:'Bearer isolated-local-probe'};
const post=async(url,payload)=>{const r=await app.inject({url,method:'POST',headers,payload});assert.equal(r.statusCode,200,r.body);return r.json();};
try{
 const upload=await app.inject({url:'/api/skills/upload',method:'POST',headers:{...headers,'content-type':'application/zip'},payload:original});assert.equal(upload.statusCode,200);
 const asset=upload.json(),project=await post('/api/migrations',{sourceAssetId:asset.assetId,name:'Private supplied package diagnostic'});
 const d=(await app.inject({url:`/api/migrations/${project.id}/diagnosis`,headers})).json();
 for(const f of d.findings){assert(f.path in source);assert.equal(f.snippet,source[f.path].split(/\r?\n/)[f.line-1].slice(0,900));}
 for(const [p,type] of [['financial_data_tool.py','SDK_IMPORT'],['file_tool.py','SDK_RESULT'],['file_tool.py','TOOL_REGISTRATION'],['financial_data_tool.py','OMITTED_IMPLEMENTATION'],['short_term_borrowing_analysis/skill.md','RESOURCE_INJECTION']])
   assert(d.findings.some(f=>f.path===p&&f.dependencyType===type),`${p}/${type}`);
 assert(d.findings.filter(f=>f.dependencyType==='TOOL_REGISTRATION').every(f=>f.layer==='HOST'));
 const candidate=await post(`/api/migrations/${project.id}/generate`,{runtime:'openjiuwen',environmentId:'local-openjiuwen',intent:'portable_method_and_adapters',baseAssetId:asset.assetId});
 const exported=await app.inject({url:`/api/migrations/${project.id}/export`,headers});assert.equal(exported.statusCode,200);
 const archive=unzipSync(exported.rawPayload);
 for(const [p,bytes] of Object.entries(files)){if(p!==asset.skillFile)assert(Buffer.from(bytes).equals(Buffer.from(archive[p])));}
 const contract=JSON.parse(Buffer.from(archive['migration-generated/neutral-contract.json']).toString());
 assert.deepEqual(contract.capabilities.map(c=>c.name),['get_financial_statement_data','get_financial_note_fragments']);
 assert(contract.resources.every(r=>r.path===null&&r.proposedPath));
 await writeFile(path.join(out,'diagnosis.json'),JSON.stringify(d,null,2),{mode:0o600});
 await writeFile(path.join(out,'candidate-draft.zip'),exported.rawPayload,{mode:0o600});
 let sdkProbe={status:'NOT_RUN'};
 if(process.env.OPENJIUWEN_TEST_JAR){
   // Only our fixed generated bridge and our fixed probe are compiled. Customer source stays inert.
   const jar=path.resolve(process.env.OPENJIUWEN_TEST_JAR),javaDir=path.join(out,'sdk-probe');await mkdir(javaDir);
   const dependencies=process.env.OPENJIUWEN_TEST_CLASSPATH_FILE?(await readFile(process.env.OPENJIUWEN_TEST_CLASSPATH_FILE,'utf8')).trim():jar;
   await writeFile(path.join(javaDir,'OpenJiuwenMigrationTool.java'),archive['migration-generated/OpenJiuwenMigrationTool.java']);
   await writeFile(path.join(javaDir,'BridgeProbe.java'),`import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import com.openjiuwen.core.foundation.tool.ToolCard;
public class BridgeProbe {
 public static void main(String[] args) throws Exception {
  var card=ToolCard.builder().id("synthetic").name("synthetic").description("synthetic").inputParams(Map.of("type","object")).build();
  var reads=new AtomicInteger();var checks=new AtomicInteger();
  var allowed=OpenJiuwenMigrationTool.create(card,a->{reads.incrementAndGet();return Map.of("status","MISSING","text","No data");},()->checks.incrementAndGet());
  Object result=allowed.invoke(Map.of());if(!result.equals(Map.of("status","MISSING","text","No data"))||reads.get()!=1||checks.get()!=2)throw new AssertionError();
  var denied=OpenJiuwenMigrationTool.create(card,a->{reads.incrementAndGet();return Map.of();},()->{throw new SecurityException("DENIED");});
  try{denied.invoke(Map.of());throw new AssertionError();}catch(SecurityException expected){}if(reads.get()!=1)throw new AssertionError();
  checks.set(0);var revoked=OpenJiuwenMigrationTool.create(card,a->{reads.incrementAndGet();return Map.of("private","fixture");},()->{if(checks.incrementAndGet()==2)throw new SecurityException("REVOKED");});
  try{revoked.invoke(Map.of());throw new AssertionError();}catch(SecurityException expected){}if(reads.get()!=2)throw new AssertionError();
  System.out.println("PASS: actual SDK Tool.invoke; allowed, denied-before-port, revoked-before-return");
 }
}`);
   const compile=execFileSync('javac',['-proc:none','-cp',dependencies,'-d',javaDir,path.join(javaDir,'OpenJiuwenMigrationTool.java'),path.join(javaDir,'BridgeProbe.java')],{encoding:'utf8'});
   const run=execFileSync('java',['-cp',`${javaDir}${path.delimiter}${dependencies}`,'BridgeProbe'],{encoding:'utf8'});
   sdkProbe={status:'PASSED_CONTROLLED_SDK_TOOL',jarSha256:createHash('sha256').update(await readFile(jar)).digest('hex'),compile,run};
 }
 const report={mode:'PRIVATE_SOURCE_STATIC_DIAGNOSIS_AND_CONTROLLED_GENERATED_ADAPTER',sourceDigest:asset.artifactSha256,candidateDigest:candidate.candidate.artifactSha256,
  findings:d.findings.length,allLineEvidenceMatched:true,sourceFilesPreserved:true,generatedDiffPaths:candidate.generation.diff.map(f=>f.path),
  ai:d.ai.status,openJiuwen:sdkProbe,uploadedScriptsExecuted:0,originalAgentScope:'NOT_RUN',targetHost:'NOT_CONNECTED',businessMigration:'NOT_VALIDATED'};
 await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
}finally{await app.close();}
