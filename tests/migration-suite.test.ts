import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import { createEvaluationService } from '../src/service/server.js';

it('separates development/holdout, forbids foreign project suites and unrelated optimization adoption',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'migration-suite-'));
 const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:dir,accessToken:'test',publicDemo:false});
 const headers={authorization:'Bearer test'},post=(url:string,payload:unknown)=>app.inject({method:'POST',url,headers,payload});
 try {
  const upload=async(version:string)=>(await app.inject({url:'/api/skills/upload',method:'POST',headers:{...headers,'content-type':'application/zip'},
   payload:Buffer.from(zipSync({'SKILL.md':strToU8(`---\nname: test\nversion: ${version}\n---\nRead only`)}))})).json();
  const a=await upload('1.0.0'),b=await upload('1.0.1');
  const p1=(await post('/api/migrations',{sourceAssetId:a.assetId,name:'one'})).json();
  const p2=(await post('/api/migrations',{sourceAssetId:a.assetId,name:'two'})).json();
  await post(`/api/migrations/${p2.id}/candidates`,{assetId:b.assetId,notes:'Synthetic'});
  const c={caseId:'DEV',name:'Synthetic',prompt:'Missing facts',evaluationGoal:'Do not invent',requiredTools:[],
   rubric:[{criterionId:'missing',label:'Missing',description:'Missing not zero',dimension:'business_completeness',weight:1,allOf:['missing']}]};
  expect((await post(`/api/migrations/${p1.id}/suites`,{summary:'bad',cases:[c],holdoutCases:[c]})).statusCode).toBe(400);
  const suite=await post(`/api/migrations/${p1.id}/suites`,{summary:'Private suite',cases:[c],holdoutCases:[{...c,caseId:'HOLDOUT'}]});
  expect(suite.statusCode).toBe(200);expect(suite.headers['cache-control']).toBe('no-store');
  const variant=(asset:typeof a)=>({mode:'skill_version',skillId:asset.skillId,version:asset.version,artifactSha256:asset.artifactSha256});
  const result=await post(`/api/migrations/${p2.id}/validate`,{pair:'AB',dataSnapshot:'fixture',permissionBasis:'fixture',sourceProjectRef:'fixture',dependencyLockRef:'fixture',
   configuration:{preparationId:suite.json().preparationId,runtime:{type:'runtime_launcher',environmentId:'missing'},executionModel:{providerId:'fixture',modelId:'fixture'},
    leftVariant:variant(a),rightVariant:variant(b),runtimeBindings:{left:{environmentId:'missing',skillAssetId:a.assetId},right:{environmentId:'missing',skillAssetId:b.assetId}}}});
  expect(result.statusCode).toBe(409);expect(result.json().message).toContain('属于本次迁移');
  expect((await post(`/api/migrations/${p2.id}/optimized-candidate`,{optimizationId:'opt-0000'})).statusCode).toBe(409);
  const report=(await app.inject({url:`/api/migrations/${p1.id}/report`,headers})).json();
  expect(report.suites[0].cases).toHaveLength(1);expect(report.suites[0].holdoutCases).toHaveLength(1);
  expect(report.project.assessment).toBe('NOT_VALIDATED');
 } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});
