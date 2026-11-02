import {expect,it} from 'vitest';
import {standardizationSchema,standardizationExample,standardizationIssues,standardDeliveryIssues,conformancePassed} from '../src/migration/tasks/domain/task-standardization.js';
import {analysisSchema,verifiedRun,hasCandidateFailures,type BundleTask} from '../src/migration/tasks/domain/task-model.js';
import {canonicalSha256} from '../src/shared/json-canonicalization.js';
// @ts-expect-error Existing deterministic fixture, never used as real business evidence.
import {fixtureAnalysis} from '../scripts/lib/migration-plan-fixture.mjs';
function fixture(){
 const files={'SKILL.md':Buffer.from('---\nname: sample\ndescription: Preserve cents\n---\nRead rules.').toString('base64')};
 const analysis=analysisSchema.parse(fixtureAnalysis({base:{members:[{id:'skill-1',skillFile:'SKILL.md'}],files}}));
 analysis.diagnosis!.tools[0]!.targetForm='SCRIPT';
 const standard=standardizationSchema.parse(structuredClone(standardizationExample));
 standard.coverage={readPaths:['SKILL.md'],gaps:[]};
 standard.requirements=[{id:'combined-result',kind:'BUSINESS',statement:'Preserve cents',toolIds:['reader'],memberIds:['skill-1'],evidence:[{path:'SKILL.md',snippet:'description: Preserve cents'}]}];
 standard.tools[0]!.toolId='reader';analysis.standardization=standard;
 return {analysis,files};
}
it('does not turn uncovered requirements into a request to rewrite passing code',()=>{
 const run={cases:[{id:'case',passed:true,reason:'actual call passed'}],requirementCoverage:[{id:'untested',status:'UNVERIFIED' as const,caseIds:[]}]};
 expect(hasCandidateFailures(run)).toBe(false);
 expect(hasCandidateFailures({...run,cases:[{...run.cases[0]!,passed:false}]})).toBe(true);
 expect(hasCandidateFailures({...run,requirementCoverage:[{id:'failed',status:'FAILED',caseIds:['case']}]})).toBe(true);
});
it('requires complete source coverage and comparison of both forms without forcing conversion',()=>{
 const {analysis,files}=fixture();analysis.standardization!.tools[0]!.action='KEEP';
 expect(standardizationIssues(analysis,files)).toEqual([]);
 analysis.standardization!.coverage.readPaths=[];
 expect(standardizationIssues(analysis,files).join()).toContain('覆盖');
 analysis.standardization!.tools[0]!.alternatives[1]!.form='SCRIPT';
 expect(standardizationIssues(analysis,files).join()).toContain('成本比较');
});
it('rejects fabricated baseline evidence, contradictory form, and missing requirement mapping',()=>{
 const {analysis,files}=fixture();analysis.standardization!.requirements[0]!.evidence[0]!.snippet='invented';
 analysis.diagnosis!.tools[0]!.targetForm='MCP';analysis.plan!.acceptanceChecks[0]!.id='other';
 const errors=standardizationIssues(analysis,files).join();expect(errors).toContain('形式不一致');expect(errors).toContain('逐项对应');expect(errors).toContain('原文');
});
it('rejects unknown configuration alternatives and contradictory required fields',()=>{
 const {analysis,files}=fixture();const s=analysis.standardization!;
 s.configurationInputs=['PRIMARY_URL','FALLBACK_URL'].map(name=>({name,label:name,description:name,required:false,sensitive:false,toolIds:['reader']}));
 s.configurationGroups=[{label:'连接地址',alternatives:[['PRIMARY_URL'],['FALLBACK_URL']]}];
 expect(standardizationIssues(analysis,files)).toEqual([]);
 s.configurationInputs[0]!.required=true;
 expect(standardizationIssues(analysis,files).join()).toContain('单独必填');
 s.configurationGroups[0]!.alternatives[1]=['UNKNOWN'];
 expect(standardizationIssues(analysis,files).join()).toContain('未声明');
});
it('does not accept files-only delivery or review without actual candidate evidence',()=>{
 const {analysis,files}=fixture();
 expect(standardDeliveryIssues(analysis,{summary:'done',services:[]},files).join()).toContain('独立候选审查');
 const delivery={summary:'done',services:[],tools:[{toolId:'reader',form:'SCRIPT' as const,entrypoint:'missing.py',files:['missing.py'],invocation:'stdin JSON',configuration:'none'}],conformance:{checks:[{requirementId:'combined-result',status:'CONFORMING' as const,reason:'ok',evidence:[]}],issues:[]}};
 expect(standardDeliveryIssues(analysis,delivery,files).join()).toContain('脚本入口');expect(standardDeliveryIssues(analysis,delivery,files).join()).toContain('缺少候选依据');
 expect(conformancePassed({...delivery.conformance,issues:['changed original business']})).toBe(false);
});
it('does not upgrade old records or treat a passing case as complete capability verification',()=>{
 const {analysis}=fixture();const configuration={environmentId:'test',modelId:'test',timeoutMs:10000,harnessTools:[]};
 const suite={name:'test',cases:[{id:'test',input:'read',criteria:['preserve cents']}]};
 const review={checks:[{requirementId:'combined-result',status:'CONFORMING' as const,reason:'source reviewed',evidence:[{path:'SKILL.md',snippet:'Preserve cents'}]}],issues:[]};
 const task={analysis,currentCandidateId:'candidate',candidates:[{id:'candidate',conformance:review}],configuration,suite,runs:[{id:'run',candidateId:'candidate',configurationDigest:canonicalSha256(configuration),suiteDigest:canonicalSha256(suite),status:'PASSED',phase:'development'}]} as unknown as BundleTask;
 expect(verifiedRun(task)).toBeUndefined();
 task.runs[0]!.requirementCoverage=[{id:'combined-result',status:'PASSED',caseIds:['test']}];expect(verifiedRun(task)?.id).toBe('run');
 delete task.analysis!.standardization;delete task.runs[0]!.requirementCoverage;expect(verifiedRun(task)?.id).toBe('run');
});
