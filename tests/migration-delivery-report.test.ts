import {it,expect} from 'vitest';
import Fastify from 'fastify';
import {MigrationReportService} from '../src/migration/application/migration-report-service.js';
import {registerMigrationRoutes} from '../src/interfaces/http/migration-routes.js';
import {inspectionFixture} from './analysis-fixture.js';
import {reuseInputDigest} from '../src/migration/domain/migration-reuse-design.js';

function fixture(){
 const inspection=inspectionFixture([]),source={assetId:inspection.assetId,artifactSha256:'a'.repeat(64)},candidate={assetId:'candidate',artifactSha256:'b'.repeat(64)};
 const design={scope:'portable',changes:[{id:'keep'}],acceptanceChecks:[{id:'check'}]};
 const project:any={id:'test',source,candidate,sourceInspection:inspection,inspection:{...inspection,reuseConformance:{proposalId:'proposal',candidateDigest:candidate.artifactSha256,
  review:{changes:[{changeId:'keep',status:'CONFORMING',evidence:[{path:'SKILL.md',snippet:'source'}]}],unexpectedDependencies:[],semanticIssues:[]}}},decisions:[],runs:[],suiteIds:[],
  reuseProposal:{proposalId:'proposal',inputDigest:reuseInputDigest(inspection,[],source.artifactSha256),sourceDigest:source.artifactSha256,approvedAt:'now',design}};
 const jobs=new Map<string,any>();let status='PASSED';
 function add(jobId:string,reuse=false,pair:'BC'|'CC'='BC'){const definition={caseId:jobId,requiredTools:[],rubric:[]};const variant={mode:'skill_version',artifactSha256:candidate.artifactSha256};
  const evidence={status:'completed',runtimeIdentityVerified:true,streamCompleted:true,toolCalls:[],metadata:{skillArtifactSha256:candidate.artifactSha256}};
  project.runs.push({jobId,pair,candidateDigest:candidate.artifactSha256,suiteSnapshot:{cases:[definition]},...(reuse?{reuseAcceptanceTaskId:'reuse-task'}:{})});
  const assessment={verdict:'PASS',reason:'ok'};
  const sideAssessment={status:'assessed',assessment};
  jobs.set(jobId,{status:'completed',configuration:{leftVariant:variant,rightVariant:variant},report:{cases:[{caseId:jobId,left:evidence,right:evidence,judge:pair==='CC'?{runtimeComparison:{left:sideAssessment,right:sideAssessment}}:{goalAssessment:assessment}}]}});
 }
 const service=new MigrationReportService({get:async()=>project} as never,{get:id=>jobs.get(id)},undefined,undefined,undefined,undefined,
  {get:async()=>({revision:0,values:{},checks:[]})} as never,async()=>({status,current:status!=='STALE',plan:null,result:null}) as never);
 return {project,add,service,setStatus:(s:string)=>{status=s;}};
}
it('does not count integrated reuse runs as ordinary business assessment',async()=>{
 const f=fixture();f.add('reuse',true);expect((await f.service.report('test')).verification).toMatchObject({targetExecution:'NOT_RUN',reuseAcceptance:'PASSED',delivery:{status:'UNVERIFIED'}});
 f.add('business');expect((await f.service.report('test')).verification.delivery.status).toBe('VERIFIED');
 f.setStatus('STALE');expect((await f.service.report('test')).verification.delivery.status).toBe('UNVERIFIED');
});
it('keeps passing cross-runtime assessments separate from migration business acceptance and workflow',async()=>{
 const f=fixture();f.project.nativeBindings={candidateDigest:f.project.candidate.artifactSha256};
 f.add('cross-runtime',false,'CC');
 const report=await f.service.report('test');
 expect(report.experiments[0]).toMatchObject({comparisonKind:'SAME_SKILL_RUNTIME_ASSESSMENT',acceptance:{status:'PASSED'}});
 expect(report.verification).toMatchObject({targetExecution:'NOT_RUN',delivery:{status:'UNVERIFIED'}});
 expect(report.workflow.stage).toBe('EVALUATE');
 f.add('business');
 expect((await f.service.report('test')).workflow.stage).toBe('EXPORT');
});
it('requires actual complete conforming review, not just matching proposal IDs',async()=>{
 const f=fixture();f.add('business');f.project.inspection.reuseConformance.review.changes[0].status='NEEDS_CHANGES';
 expect((await f.service.report('test')).verification).toMatchObject({reuseDesign:'NOT_REVIEWED',delivery:{status:'UNVERIFIED'}});
});
it.each(['VERIFIED','UNVERIFIED'])('export names and headers use the complete delivery status: %s',async status=>{
 const app=Fastify();registerMigrationRoutes(app,{privateWorkspaceEnabled:true,migrations:{report:async()=>({project:{candidate:{skillId:'sample',artifactSha256:'digest'}},verification:{targetExecution:'PASSED',reuseAcceptance:status==='VERIFIED'?'PASSED':'NOT_RUN',delivery:{status}}}),exportPackage:async()=>({archive:Buffer.from('zip'),candidateDigest:'digest',skillId:'sample'})} as never,skills:{} as never,environments:{} as never,runtimeDeliveries:{} as never});
 try{const reply=await app.inject({method:'GET',url:'/api/migrations/test/export'});expect(reply.statusCode).toBe(200);expect(reply.headers['x-migration-acceptance']).toBe(status);
  expect(reply.headers['x-migration-business-acceptance']).toBe('PASSED');expect(reply.headers['content-disposition']).toContain(status==='VERIFIED'?'sample.zip':'sample-unverified.zip');
 }finally{await app.close();}
});
it('does not apply a different candidate verification to the downloaded bytes',async()=>{
 const app=Fastify();registerMigrationRoutes(app,{privateWorkspaceEnabled:true,migrations:{report:async()=>({project:{candidate:{artifactSha256:'new'}},verification:{targetExecution:'PASSED',reuseAcceptance:'PASSED',delivery:{status:'VERIFIED'}}}),
  exportPackage:async()=>({archive:Buffer.from('old zip'),candidateDigest:'old',skillId:'sample'})} as never,skills:{} as never,environments:{} as never,runtimeDeliveries:{} as never});
 try{const reply=await app.inject({method:'GET',url:'/api/migrations/test/export'});expect(reply.headers['x-migration-acceptance']).toBe('UNVERIFIED');expect(reply.headers['x-migration-reuse-acceptance']).toBe('STALE');expect(reply.headers['content-disposition']).toContain('sample-unverified.zip');}finally{await app.close();}
});
