import {expect,it} from 'vitest';
import {calibrateJudges,type CalibrationEvaluation} from '../src/evaluation/application/judge-calibration.js';
import type {HumanReview,ReviewTarget} from '../src/evaluation/domain/human-review.js';
import {comparisonCalibrations,migrationCalibrations} from '../src/service/evaluation-calibration.js';
import {canonicalSha256} from '../src/shared/json-canonicalization.js';

const target=(caseId:string,id:string):ReviewTarget=>({caseId,id,label:'案例结论',scope:'case',machine:'PASS',outcomes:['PASS','FAIL','UNVERIFIED'],evidenceRoot:id});
const base=[target('a','/cases/0'),target('b','/cases/1')];
const records:HumanReview[]=base.map((t,i)=>({id:String(i),createdAt:'now',sourceDigest:'frozen',targetId:t.id,reviewer:'expert',kind:'ANNOTATION',outcome:'PASS',reason:'checked',evidenceRefs:[t.id+'/evidence'],resolves:[]}));
const evaluation=(targets:ReviewTarget[],extra:Partial<CalibrationEvaluation>={}):CalibrationEvaluation=>({id:'v2',label:'v2',judgeIdentity:'judge-v2',compatible:true,targets,...extra});
it('aligns reordered cases by semantic identity and keeps original human records untouched',()=>{
  const before=structuredClone({base,records});
  const result=calibrateJudges(base,records,[evaluation([{...target('b','/cases/0'),machine:'FAIL'},target('a','/cases/1')])])[0]!;
  expect(result.summary[0]).toMatchObject({total:2,comparable:2,agree:1,disagree:1,agreement:0.5});
  expect({base,records}).toEqual(before);
});
it('retains missing outcomes and reports new unannotated items',()=>{
  const result=calibrateJudges(base,records,[evaluation([target('a','/cases/1'),target('new','/cases/2')])])[0]!;
  expect(result).toMatchObject({missingTargets:1,additionalTargets:1});
  expect(result.summary[0]).toMatchObject({total:2,reviewed:2,machineMissing:1,comparable:1});
});
it('does not compare changed outcome vocabularies, ambiguous identities or incompatible materials',()=>{
  expect(calibrateJudges(base,records,[evaluation([{...base[0]!,outcomes:['left','right','tie'],machine:'left'}])])[0]!.summary[0]).toMatchObject({comparable:0,machineMissing:2});
  for(const candidate of [evaluation([base[0]!,base[0]!]),evaluation(base,{compatible:false,reason:'changed evidence'})]){
    expect(calibrateJudges(base,records,[candidate])[0]).toMatchObject({compatible:false,summary:[]});
  }
});
it('keeps disputes out of agreement for every rescoring version',()=>{
  const disputed:HumanReview={...records[0]!,id:'other',reviewer:'other',outcome:'FAIL'};
  expect(calibrateJudges(base,[...records,disputed],[evaluation(base)])[0]!.summary[0]).toMatchObject({disputed:1,comparable:1,agree:1});
});
it('checks migration phase plans and source/evidence digests before reusing opinions',()=>{
  const plan={methods:[]},evidence={output:'answer'};
  const run={id:'run',phase:'development',suite:{cases:[{id:'a',evaluationPlan:plan}],holdoutCases:[{id:'secret',evaluationPlan:{other:true}}]},cases:[{id:'a',evidence,passed:true}]};
  const record={id:'score',createdAt:'now',sourceRunId:'run',sourceDigest:canonicalSha256(run),plan,judgeDigest:'judge',cases:[{id:'a',status:'PASS',evidenceDigest:canonicalSha256(evidence)}]};
  expect(migrationCalibrations(run as any,[record] as any)[0]).toMatchObject({compatible:true});
  expect(migrationCalibrations(run as any,[{...record,plan:{changed:true}}] as any)[0]).toMatchObject({compatible:false});
  expect(migrationCalibrations(run as any,[{...record,sourceDigest:'stale'}] as any)[0]).toMatchObject({compatible:false});
  expect(migrationCalibrations(run as any,[{...record,cases:[{...record.cases[0],evidenceDigest:'changed'}]}] as any)[0]).toMatchObject({compatible:false});
});
it('expands repeated comparison judgments but rejects changed execution evidence',()=>{
  const row={caseId:'a',left:{output:'left'},right:{output:'right'},judge:{winner:'left'}};
  const job={report:{reportFingerprint:'frozen',cases:[row]},rescorings:[{id:'score',createdAt:'now',sourceReportFingerprint:'frozen',judgeId:'judge',cases:[row],attempts:[{cases:[row]},{cases:[{...row,judge:{winner:'right'}}]}]}]};
  expect(comparisonCalibrations(job as any).map(x=>x.compatible)).toEqual([true,true]);
  const changed=structuredClone(job);changed.rescorings[0]!.attempts[1]!.cases[0]!.left={output:'different'};
  expect(comparisonCalibrations(changed as any)[1]).toMatchObject({compatible:false});
});
