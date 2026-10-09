import { expect, it } from 'vitest';
import { MigrationRuntimeRebuildService } from '../src/migration/application/migration-runtime-rebuild-service.js';
import {MigrationReportService} from '../src/migration/application/migration-report-service.js';
import type { MigrationProjectStore } from '../src/migration/application/migration-project-store.js';
import type { MigrationEvaluationJobReader } from '../src/migration/application/migration-evaluation-ports.js';
import type { MigrationEnvironmentRepository } from '../src/migration/application/migration-environment-repository.js';
import type { MigrationProject } from '../src/migration/domain/migration-project.js';

const asset={assetId:'candidate',artifactSha256:'a'.repeat(64)} as MigrationProject['source'];
const baseline={revisionId:'f'.repeat(64),skill:{assetId:'candidate',artifactSha256:asset.artifactSha256},
  runtime:{environmentId:'env-1',launcherEnvironmentId:'env-1',deploymentId:'deployment-1',artifactSha256:'b'.repeat(64),capabilitiesDigest:'c'.repeat(64),endpoint:'https://example.test/launcher/'},
  executionModelDigest:'d'.repeat(64),configurationDigest:'e'.repeat(64),toolBindingsDigest:'f'.repeat(64)};
const project={id:'migration-1234',source:asset,candidate:asset,runs:[{jobId:'job-1',pair:'BC',candidateDigest:asset.artifactSha256,
  solutionRevisions:{left:baseline,right:baseline}}]} as unknown as MigrationProject;
const environment={environmentId:'env-1',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:'https://example.test/launcher/',
  delivery:{deploymentId:'deployment-1',artifactSha256:'b'.repeat(64)}};
const stores={
  projects:{runExclusive:async(_key:string,operation:()=>Promise<unknown>)=>operation(),get:async()=>project,save:async()=>undefined} as MigrationProjectStore,
  jobs:{get:()=>({status:'completed',report:{cases:[{caseId:'case-1',right:{status:'completed',toolCalls:[{name:'lookup',status:'failed'}]}}]}})} as MigrationEvaluationJobReader,
  environments:{get:async()=>environment} as unknown as MigrationEnvironmentRepository,
};

it('creates an immutable Builder rebuild request linked to a real run and baseline Launcher',async()=>{
  project.runtimeRebuilds=[];
  const service=new MigrationRuntimeRebuildService(stores.projects,stores.jobs,stores.environments);
  const proposal={jobId:'job-1',hypothesis:{id:'finding-1',issue:'Missing handoff',expectedBehavior:'Preserve state inside a case'},
    evidence:[{caseId:'case-1',summary:'The second call could not see the first result'}]};
  const request=await service.propose(project.id,proposal);
  expect(request.rebuild?.baseline).toMatchObject({deploymentId:'deployment-1',artifactSha256:'b'.repeat(64),solutionRevisionId:baseline.revisionId});
  expect(request.source).toMatchObject({assetId:'candidate',artifactSha256:asset.artifactSha256});
  expect(project.runtimeRebuilds?.at(-1)?.requirements.requirementsDigest).toBe(request.requirementsDigest);
  await expect(service.propose(project.id,{...proposal,evidence:[{caseId:'invented',summary:'not executed'}]})).rejects.toThrow('实际执行');
});

it('does not leave a verified and adopted Harness task labelled as awaiting retest',async()=>{
  const record={id:'migration-1234',source:asset,candidate:asset,runs:[],
    improvementPlans:[{planId:'plan',sourceJobId:'old',candidateDigest:asset.artifactSha256}],
    runtimeRebuilds:[{candidateDigest:asset.artifactSha256,requirements:{requestId:'request',requirementsDigest:'req',rebuild:{hypothesis:{id:'plan'}}}}],
    runtimeDelivery:{requirementsDigest:'req'},improvementTasks:[{status:'ADOPTED',bestCandidate:asset,finalVerified:true,iterations:[{planId:'plan'}]}],
  } as unknown as MigrationProject;
  const report=new MigrationReportService({get:async()=>record} as any,{get:()=>null} as any,undefined,undefined,undefined,undefined,
    {get:async()=>({revision:0,values:{},checks:[]})} as any);
  expect((await report.report(record.id)).improvementPlans[0]?.action.status).toBe('VERIFIED_ADOPTED');
});

it('binds a planned Harness change to its exact solution baseline and explicit capability contract',async()=>{
  project.runtimeRebuilds=[];
  const capability={id:'context-handoff',name:'handoff_context',required:true,reason:'Consecutive calls need the same case state',
    contract:{inputSchema:{type:'object'},outputSchema:{type:'object'},errorSchema:{type:'object'},semantics:'Isolated within one runtime instance'},
    constraints:{permissions:['case.read'],sideEffects:'read',isolation:'per_runtime_instance'},preferredTargetCapability:null,
    consumerTools:['lookup'],evidence:[{path:'tools/lookup.py',line:8,detail:'reads context from previous tool call'}]};
  project.improvementPlans=[{planId:'improvement-1',sourceJobId:'job-1',baseSolutionRevisionId:baseline.revisionId,
    candidateDigest:asset.artifactSha256,developmentCaseIds:['case-1'],createdAt:new Date().toISOString(),modelId:'fixture',status:'PROPOSED',
    hypothesis:{layer:'HARNESS',issue:'Missing handoff',expectedBehavior:'Preserve state inside a case',evidenceCaseIds:['case-1'],validation:'Run two calls',risk:'State leakage',confidence:'MEDIUM'},abstainReason:null}];
  const service=new MigrationRuntimeRebuildService(stores.projects,stores.jobs,stores.environments);
  const request=await service.propose(project.id,{planId:'improvement-1',requiredCapabilities:[capability]});
  expect(request.rebuild?.hypothesis.id).toBe('improvement-1');
  expect(request.rebuild?.evidence[0]?.summary).toContain('lookup:failed');
  expect(request.requiredCapabilities[0]?.id).toBe('context-handoff');
  project.improvementPlans[0]!.baseSolutionRevisionId='e'.repeat(64);
  await expect(service.propose(project.id,{planId:'improvement-1',requiredCapabilities:[capability]})).rejects.toThrow('基线方案已变化');
});
