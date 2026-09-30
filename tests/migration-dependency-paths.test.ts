import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {resolveDependencyPath,analyzeDependencies} from '../src/migration/infrastructure/migration-dependencies.js';
import {inspectionFixture,toolFixture,SKILL_MD,analyzedTool} from './analysis-fixture.js';
import {createEvaluationService} from '../src/service/server.js';
const files={'scripts/check.py':'rules = load_rules()\n','assets/rules.json':'{"mealLimit":"150.00"}\n'};
function payload(root:string){return {status:'PRODUCED',skill:{status:'COMPLIANT',findings:[]},tools:[analyzedTool({name:'check',sourcePaths:['scripts/check.py'],sample:{},inputSchema:{type:'object'}})],dependencyAnalysis:{dependencies:[{key:'rules',name:'Rules',kind:'CONFIG',owner:'TOOL',action:'KEEP',contractStatus:'KNOWN',purpose:'Read the included rules',blocking:true,availability:'AVAILABLE',references:[{toolName:'check',path:root+'/scripts/check.py',snippet:'rules = load_rules()'}],resolvedPaths:[root+'/assets/rules.json'],resolutionEvidence:[{path:root+'/assets/rules.json',snippet:'"mealLimit":"150.00"'}]}],chains:[{toolName:'check',nodes:[{id:'rules',title:'Read rules',detail:'Read included rules',dependencyKeys:['rules'],evidence:[{path:root+'/scripts/check.py',snippet:'rules = load_rules()'}]}],edges:[]}]}}}
it('resolves Windows absolute and relative paths to the actual asset key, including case and separators',()=>{
 const root='C:\\Temp\\current';
 for(const value of ['assets/rules.json','assets\\rules.json','./assets/rules.json','assets/../assets/rules.json','c:/temp/CURRENT/ASSETS/RULES.JSON','C:\\Temp\\current\\assets\\rules.json'])expect(resolveDependencyPath(value,files,root)).toEqual({path:'assets/rules.json'});
});
it('resolves UNC workspace paths and rejects a different share',()=>{
 expect(resolveDependencyPath('\\\\server\\share\\current\\assets\\rules.json',files,'//server/share/current')).toEqual({path:'assets/rules.json'});
 expect(resolveDependencyPath('//server/other/current/assets/rules.json',files,'//server/share/current')).toHaveProperty('error');
});
it('keeps POSIX paths case sensitive and accepts absolute paths within the current workspace',()=>{
 expect(resolveDependencyPath('/tmp/current/assets/rules.json',files,'/tmp/current')).toEqual({path:'assets/rules.json'});
 expect(resolveDependencyPath('ASSETS/rules.json',files,'/tmp/current')).toEqual({error:'工程中不存在该文件'});
});
it('rejects outside, other invocation, drive-relative, ambiguous and nonexistent paths without suffix guessing',()=>{
 for(const value of ['../assets/rules.json','C:/Temp/other/assets/rules.json','C:/Temp/current-evil/assets/rules.json','D:/Temp/current/assets/rules.json','C:/Temp/current/../other/assets/rules.json','C:assets/rules.json'])expect(resolveDependencyPath(value,files,'C:/Temp/current')).toHaveProperty('error');
 expect(resolveDependencyPath('C:/Temp/current/assets/rules.json',files)).toHaveProperty('error');
 expect(resolveDependencyPath('assets/missing.json',files,'C:/Temp/current')).toEqual({error:'工程中不存在该文件'});
 expect(resolveDependencyPath('assets/rules.json',{...files,'ASSETS/RULES.JSON':'other'},'C:/Temp/current')).toHaveProperty('error');
});
it('recognizes available dependencies from absolute evidence and resolvedPaths and retains snippet verification',()=>{
 const root='C:/Temp/current',inspection=inspectionFixture([toolFixture({name:'check',sourcePaths:['scripts/check.py']})]);
 const analysis=analyzeDependencies(payload(root),inspection,files,[],0,'digest',root);
 expect(analysis.status).toBe('COMPLETE');expect(analysis.dependencies[0]!.resolvedPaths).toEqual(['assets/rules.json']);expect(analysis.dependencies[0]!.availability).toBe('AVAILABLE');expect(analysis.dependencies[0]!.evidence.every(e=>!e.path.startsWith('C:'))).toBe(true);
 const invalid=payload(root);invalid.dependencyAnalysis.dependencies[0]!.resolutionEvidence[0]!.snippet='nonexistent rules';expect(analyzeDependencies(invalid,inspection,files,[],0,'digest',root).status).toBe('PARTIAL');
 const outside=payload('C:/Temp/other');expect(analyzeDependencies(outside,inspection,files,[],0,'digest',root).status).toBe('PARTIAL');
});
it('passes invocation metadata through the service and does not trust a workspaceRoot inside the model judgement',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dependency-path-store-')),root='C:/Temp/current';
 let trust=true;const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:dir,accessToken:'test',publicDemo:false,migrationAnalyzer:async()=>({status:'PRODUCED',payload:{...payload(root),workspaceRoot:root},...(trust?{workspaceRoot:root}:{}),scanner:{scannerDigest:'a'.repeat(64),coverage:Object.keys(files).map(path=>({path,status:'TEXT_INSPECTED'}))}})});
 const headers={authorization:'Bearer test'};
 try{
  const a=(await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:Buffer.from(zipSync({'SKILL.md':strToU8(SKILL_MD),...Object.fromEntries(Object.entries(files).map(([p,t])=>[p,strToU8(t)]))}))})).json();
  const p=(await app.inject({method:'POST',url:'/api/migrations',headers,payload:{sourceAssetId:a.assetId,name:'path verification'}})).json();
  const r=await app.inject({method:'POST',url:`/api/migrations/${p.id}/inspect`,headers});expect(r.statusCode).toBe(200);expect(r.json().dependencyAnalysis.status).toBe('COMPLETE');
  trust=false;const rejected=await app.inject({method:'POST',url:`/api/migrations/${p.id}/inspect/source`,headers});expect(rejected.statusCode).toBe(200);expect(rejected.json().dependencyAnalysis.status).toBe('PARTIAL');
 }finally{await app.close();await rm(dir,{recursive:true,force:true})}
});
