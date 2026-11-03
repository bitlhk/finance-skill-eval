import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import Fastify from 'fastify';
import {HumanReviewStore,type ReviewMaterial} from '../src/service/human-review-store.js';
import {reviewConsensus,type ReviewSource,type ReviewTarget} from '../src/evaluation/domain/human-review.js';
import {registerEvaluationReviewRoutes} from '../src/interfaces/http/evaluation-review-routes.js';
import {comparisonReviewTargets,migrationReviewTargets} from '../src/evaluation/application/review-targets.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const source:ReviewSource={kind:'migration',id:'task',runId:'run'};
const target:ReviewTarget={id:'/cases/0',caseId:'case',label:'Verdict',scope:'case',machine:'PASS',outcomes:['PASS','FAIL','UNVERIFIED'],evidenceRoot:'/cases/0'};
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'human-review-'));roots.push(root);
  const material:ReviewMaterial={digest:'a'.repeat(64),targets:[target],resources:{cases:[{evidence:{output:'Observed'}}]}};
  return {material,store:new HumanReviewStore(root,async()=>material)};
}
const entry=(reviewer='alice',outcome='PASS')=>({targetId:target.id,reviewer,outcome,reason:'Checked actual output',evidenceRefs:['/cases/0/evidence/output']});
it('exposes new rescoring calibration without staling or rewriting human annotations',async()=>{
  const {store,material}=await fixture();
  const original=await store.append({source,sourceDigest:material.digest,entries:[entry()]});
  material.evaluations=[{id:'v2',label:'v2',judgeIdentity:'judge-v2',compatible:true,targets:[{...target,machine:'FAIL'}]}];
  const view=await store.get(source);
  expect(view.records).toEqual(original.records);expect(view.staleRecordCount).toBe(0);
  expect(view.summary[0]).toMatchObject({agree:1});
  expect(view.calibrations[0]!.summary[0]).toMatchObject({agree:0,disagree:1});
});
it('preserves original evidence, stores disagreements and requires every current opinion for adjudication',async()=>{
  const {store,material}=await fixture(),original=structuredClone(material);
  const first=await store.append({source,sourceDigest:material.digest,entries:[entry(),entry('bob','FAIL')]});
  expect(first.summary[0]).toMatchObject({reviewed:1,disputed:1,comparable:0,agreement:null});
  await expect(store.append({source,sourceDigest:material.digest,entries:[{...entry('reviewer'),kind:'ADJUDICATION',resolves:[first.records[0]!.id]}]})).rejects.toThrow('全部');
  const resolved=await store.append({source,sourceDigest:material.digest,entries:[{...entry('reviewer'),kind:'ADJUDICATION',resolves:first.records.map(r=>r.id)}]});
  expect(resolved.summary[0]).toMatchObject({disputed:0,comparable:1,agree:1,agreement:1});
  expect(material).toEqual(original);expect(resolved.records).toHaveLength(3);
  const bob=resolved.records.find(r=>r.reviewer==='bob')!;
  const revised=await store.append({source,sourceDigest:material.digest,entries:[{...entry('bob','UNVERIFIED'),supersedes:bob.id}]});
  expect(reviewConsensus(target,revised.records).decision).toBeUndefined();
  expect(revised.summary[0]?.disputed).toBe(1);expect(revised.records).toHaveLength(4);
});
it('validates imports atomically and rejects invented or cross-case references',async()=>{
  const {store,material}=await fixture();
  await expect(store.append({source,sourceDigest:material.digest,entries:[entry(),{...entry('bob'),evidenceRefs:['/cases/1/evidence/output']}]})).rejects.toThrow('引用');
  expect((await store.get(source)).records).toEqual([]);
  await expect(store.append({source,sourceDigest:material.digest,entries:[{...entry(),outcome:'left'}]})).rejects.toThrow('结论');
  await expect(store.append({source,sourceDigest:material.digest,entries:[{...entry(),evidenceRefs:['/cases/0/missing']}]})).rejects.toThrow('引用');
});
it('serializes concurrent revisions and retains old-source history without counting it',async()=>{
  const {store,material}=await fixture();
  const initial=await store.append({source,sourceDigest:material.digest,entries:[entry()]});
  const request={source,sourceDigest:material.digest,entries:[{...entry('alice','FAIL'),supersedes:initial.records[0]!.id}]};
  const results=await Promise.allSettled([store.append(request),store.append(request)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  material.digest='b'.repeat(64);
  const view=await store.get(source);expect(view.records).toEqual([]);expect(view.staleRecordCount).toBe(2);
  await expect(store.append(request)).rejects.toThrow('变化');
});
it('keeps human uncertainty and missing machine verdicts out of agreement without hiding their counts',async()=>{
  const {store,material}=await fixture();material.targets=[{...target,machine:null}];
  const first=await store.append({source,sourceDigest:material.digest,entries:[entry()]});
  expect(first.summary[0]).toMatchObject({machineMissing:1,comparable:0,agreement:null});
  const next=await store.append({source,sourceDigest:material.digest,entries:[{...entry('alice','UNVERIFIED'),supersedes:first.records[0]!.id}]});
  expect(next.summary[0]).toMatchObject({humanUnverified:1,comparable:0,reviewed:1});
});
it('enforces the private-workspace route boundary',async()=>{
  const {store}=await fixture(),app=Fastify();registerEvaluationReviewRoutes(app,store,false);
  try{expect((await app.inject({url:'/api/evaluation-reviews?kind=migration&id=task&runId=run'})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/evaluation-reviews',payload:{}})).statusCode).toBe(403);
  }finally{await app.close();}
});
it('does not treat service or runtime comparison placeholder ties as answer preferences',()=>{
  const report={cases:[{caseId:'case',judge:{winner:'tie',serviceComparison:{verdict:'FAIL',checks:[]}}}]} as any;
  expect(comparisonReviewTargets(report)).toMatchObject([{scope:'case',machine:'FAIL',outcomes:['PASS','FAIL','UNVERIFIED']}]);
  expect(migrationReviewTargets({cases:[{id:'case',passed:false,reason:'Unavailable',failureStage:'JUDGE'}]})[0]?.machine).toBeNull();
});
