import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {strToU8,zipSync,unzipSync} from 'fflate';
import {MigrationProjectRepository} from '../src/migration/infrastructure/migration-project-repository.js';
import {MigrationPlanningService} from '../src/migration/application/migration-planning-service.js';
import {MigrationGenerationService} from '../src/migration/application/migration-generation-service.js';
import {MigrationCandidateInspectionService} from '../src/migration/application/migration-candidate-inspection-service.js';
import {MigrationGenerationError} from '../src/migration/domain/migration-generation-progress.js';
import type {MigrationProject} from '../src/migration/domain/migration-project.js';
import type {MigrationReusePlanner} from '../src/migration/application/migration-reuse-planner.js';
import {migrationWorkflow} from '../src/migration/domain/migration-workflow.js';
import {projectMigrationPlan} from '../src/migration/domain/migration-reuse-design.js';
import {generationInputDigest} from '../src/migration/domain/migration-generation-binding.js';
import {inspectionFixture,toolFixture,SKILL_MD} from './analysis-fixture.js';
import {reusePlannerFixture} from './reuse-design-fixture.js';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))});
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'eval-generation-recovery-'));roots.push(root);
  const store=new MigrationProjectRepository(root),id='migration-1234-abcd';
  const files={'SKILL.md':strToU8(SKILL_MD),'scripts/lookup.py':strToU8('def lookup(account_id): return {"amount": 10}\n'),'assets/data.bin':new Uint8Array([255,0])};
  const archives=new Map<string,Uint8Array>([['source',zipSync(files)]]);
  const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
  const source={schemaVersion:'finance.skill-eval.skill-asset.v1' as const,assetId:'source',skillId:'fixture-skill',version:'1',displayName:'test',description:'test',sourceType:'uploaded',artifactSha256:sha(archives.get('source')!),skillFile:'SKILL.md',fileCount:3,createdAt:'now'};
  const inspection=inspectionFixture([toolFixture({name:'lookup',sourcePaths:['scripts/lookup.py'],portability:'PORTABLE_SCRIPT',kind:'SCRIPT'})],'source');
  inspection.assetDigest=source.artifactSha256;inspection.staticAnalysis={status:'COMPLETE',dependencyStatus:'NO_BINDING_IN_CHECKED_SCOPE',scannerDigest:'a'.repeat(64),incompleteFiles:[]};
  inspection.dependencyAnalysis={status:'COMPLETE',revision:0,materialsDigest:'materials',dependencies:[],chains:[],rejectedClaims:0};
  const project:MigrationProject={schemaVersion:'finance.skill-migration.v2',id,name:'test',createdAt:'now',source,candidate:null,candidateNotes:'',runs:[],assessment:'NOT_VALIDATED',inspection,sourceInspection:structuredClone(inspection),decisions:[{toolId:inspection.tools[0]!.toolId,form:'SCRIPT',language:'python',reason:'reuse',baseAssetId:'source',decidedAt:'now'}]};
  await store.save(project);
  let serial=0,materials='materials';
  const skills={readArchive:vi.fn(async(assetId:string)=>unzipSync(archives.get(assetId)!)),
    uploadZip:vi.fn(async(bytes:Buffer,options?:{version?:string})=>{const assetId=`candidate-${++serial}`;archives.set(assetId,bytes);return {...source,assetId,artifactSha256:sha(bytes),version:options?.version??'2'}})};
  const planning=new MigrationPlanningService(store,{serialize:()=>null},undefined,reusePlannerFixture,skills as any);
  const proposal=await planning.propose(id);await planning.approve(id,{proposalId:proposal.proposalId,inputDigest:proposal.inputDigest});
  const generate=vi.fn(async()=>({implementations:{},generationStats:{agentAttempts:1,outputCorrectionAttempts:0}}));
  const pack=vi.fn(()=>({files,generations:[],diff:[]}));
  const diagnose=vi.fn(async(candidate:any)=>({digest:candidate.artifactSha256,status:'COMPLETE',coverage:[],findings:[],ai:{status:'NOT_REQUESTED'},scannerDigest:'c'.repeat(64)}));
  const analyzer=vi.fn(async()=>({status:'PRODUCED',payload:{}}));
  const review=vi.fn<MigrationReusePlanner>(reusePlannerFixture);
  const candidateInspection=new MigrationCandidateInspectionService({diagnose} as any,{
    analyzer:analyzer as any,results:{inspection:({assetId,assetDigest}:any)=>({...structuredClone(inspection),assetId,assetDigest})} as any,
    dependencies:{analyze:()=>structuredClone(inspection.dependencyAnalysis!)},reusePlanner:review,
  });
  const supplements={get:async()=>({items:[]}),digest:()=>materials};
  const service=()=>new MigrationGenerationService(new MigrationProjectRepository(root),skills as any,supplements as any,{package:pack}, {generate} as any,candidateInspection);
  return {root,id,store,skills,generate,pack,diagnose,analyzer,review,service,planning,inspection,setMaterials:(value:string)=>{materials=value}};
}

it('persists A4, immutable candidate and analysis; a new service resumes only failed review',async()=>{
  const f=await fixture();
  f.review.mockRejectedValueOnce(new MigrationGenerationError({phase:'PLAN_REVIEW',code:'MODEL_OUTPUT_INVALID',message:'审查格式不正确',recoverable:true,fields:['review.changes (invalid_type)']}));
  await expect(f.service().generate(f.id,{baseAssetId:'source'})).rejects.toThrow('审查格式');
  const failed=await f.store.get(f.id),attempt=failed.generationAttempts!.at(-1)!;
  expect(failed.candidate).toBeNull();expect(attempt.candidate?.assetId).toBe('candidate-1');
  expect(attempt.inspectionCheckpoint?.inspection?.tools[0]?.toolId).toBe(f.inspection.tools[0]!.toolId);
  expect(attempt.progress.failure).toMatchObject({phase:'PLAN_REVIEW',recoverable:true,fields:['review.changes (invalid_type)']});
  expect((await f.service().executionProgress(f.id))?.status).toBe('FAILED');
  const done=await f.service().generate(f.id,{baseAssetId:'source',mode:'resume'});
  expect(done.candidate?.assetId).toBe('candidate-1');expect(done.candidateHistory).toHaveLength(1);
  for(const call of [f.generate,f.pack,f.skills.uploadZip,f.diagnose,f.analyzer])expect(call).toHaveBeenCalledTimes(1);
  expect(f.review).toHaveBeenCalledTimes(2);expect(done.generationAttempts).toHaveLength(1);
  expect((await f.service().executionProgress(f.id))?.status).toBe('COMPLETED');
  expect(done.generationAttempts![0]!.failures?.[0]?.failure.code).toBe('MODEL_OUTPUT_INVALID');
  // Review and execution read the same full artifact, including non-document resources.
  expect(await f.skills.readArchive(done.candidate!.assetId)).toHaveProperty('assets/data.bin');
});

it('persists successful code generation before packaging fails and does not regenerate it',async()=>{
  const f=await fixture();f.pack.mockImplementationOnce(()=>{throw new Error('private key=secret transport failure')});
  await expect(f.service().generate(f.id,{baseAssetId:'source'})).rejects.toThrow('组装候选包');
  const failed=await f.store.get(f.id);expect(failed.generationAttempts![0]!.delivery).toBeTruthy();
  expect(JSON.stringify(failed)).not.toContain('key=secret');
  await f.service().generate(f.id,{baseAssetId:'source'});
  expect(f.generate).toHaveBeenCalledTimes(1);expect(f.pack).toHaveBeenCalledTimes(2);
});

it('keeps an explicit negative verdict and refuses repeated review of the same artifact',async()=>{
  const f=await fixture();f.review.mockImplementationOnce(async input=>{
    const output=await reusePlannerFixture(input) as any;
    output.review.changes[0].status='NEEDS_CHANGES';output.review.changes[0].reason='Business behavior changed';return output;
  });
  await expect(f.service().generate(f.id,{baseAssetId:'source'})).rejects.toThrow('未落实');
  const failed=await f.store.get(f.id),attempt=failed.generationAttempts![0]!;
  expect(attempt.progress.failure?.recoverable).toBe(false);
  expect(attempt.inspectionCheckpoint?.inspection?.reuseConformance?.review.changes[0]?.status).toBe('NEEDS_CHANGES');
  await expect(f.service().generate(f.id,{baseAssetId:'source',mode:'resume'})).rejects.toThrow('未落实');
  expect(f.review).toHaveBeenCalledTimes(1);expect((await f.store.get(f.id)).candidate).toBeNull();
  const packed=f.pack();f.pack.mockImplementationOnce(()=>({...packed,files:{...packed.files,'scripts/lookup.py':strToU8('def lookup(account_id): return {"amount": 10, "corrected": True}\n')}}));
  await f.service().generate(f.id,{baseAssetId:'source',mode:'restart'});
  expect(f.generate).toHaveBeenCalledTimes(2);expect(f.skills.uploadZip).toHaveBeenCalledTimes(2);
  const done=await f.store.get(f.id);expect(done.generationAttempts).toHaveLength(2);
  expect(done.generationAttempts![0]!.progress.failure?.recoverable).toBe(false);
});

it('cannot turn a negative verdict into approval by generating an identical artifact again',async()=>{
  const f=await fixture();f.review.mockImplementationOnce(async input=>{
    const output=await reusePlannerFixture(input) as any;output.review.semanticIssues=['Behavior drift'];return output;
  });
  await expect(f.service().generate(f.id,{baseAssetId:'source'})).rejects.toThrow('未落实');
  await expect(f.service().generate(f.id,{baseAssetId:'source',mode:'restart'})).rejects.toThrow('完全相同');
  expect(f.review).toHaveBeenCalledTimes(1);expect((await f.store.get(f.id)).candidate).toBeNull();
});

it('invalidates checkpoints when the confirmed proposal changes and retains old attempts',async()=>{
  const f=await fixture();f.review.mockRejectedValueOnce(new Error('private provider error'));
  await expect(f.service().generate(f.id,{baseAssetId:'source'})).rejects.toThrow('未完成');
  const proposal=await f.planning.propose(f.id);await f.planning.approve(f.id,{proposalId:proposal.proposalId,inputDigest:proposal.inputDigest});
  await expect(f.service().generate(f.id,{baseAssetId:'source'})).rejects.toThrow('已变化');
  expect(f.generate).toHaveBeenCalledTimes(1);expect(f.review).toHaveBeenCalledTimes(1);
  await f.service().generate(f.id,{baseAssetId:'source',mode:'restart'});
  expect((await f.store.get(f.id)).generationAttempts).toHaveLength(2);
});

it('blocks resume after material changes, without erasing the original failure',async()=>{
  const f=await fixture();f.review.mockRejectedValueOnce(new Error('private error'));
  await expect(f.service().generate(f.id,{baseAssetId:'source'})).rejects.toThrow('未完成');
  f.setMaterials('different');
  await expect(f.service().generate(f.id,{baseAssetId:'source'})).rejects.toThrow('补充材料已变化');
  expect((await f.store.get(f.id)).generationAttempts![0]!.progress.failure?.phase).toBe('PLAN_REVIEW');
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it('recognizes interrupted persisted work after service restart without treating it as acceptance',async()=>{
  const f=await fixture();f.review.mockRejectedValueOnce(new Error('private error'));
  await expect(f.service().generate(f.id,{baseAssetId:'source'})).rejects.toThrow();
  const saved=await f.store.get(f.id),attempt=saved.generationAttempts![0]!;
  attempt.progress.status='RUNNING';delete attempt.progress.failure;await f.store.save(saved);
  expect((await f.service().executionProgress(f.id))?.status).toBe('INTERRUPTED');
  expect(migrationWorkflow(saved,{migrationPlan:projectMigrationPlan(saved),runtimeRequirementsPending:false,technicalReady:true,evaluationCompleted:true}).stage).toBe('GENERATE');
  expect(saved.candidate).toBeNull();
  await f.service().generate(f.id,{baseAssetId:'source'});expect(f.generate).toHaveBeenCalledTimes(1);
});

it('binds stable facts rather than timestamps, and does not ignore relevant fact changes',async()=>{
  const f=await fixture(),p=await f.store.get(f.id),digest=generationInputDigest(p,'materials');
  p.sourceInspection!.inspectedAt='later';p.decisions![0]!.decidedAt='later';
  expect(generationInputDigest(p,'materials')).toBe(digest);
  p.sourceInspection!.tools[0]!.outputSchema={type:'object',required:['new']};
  expect(generationInputDigest(p,'materials')).not.toBe(digest);
});

it('does not regenerate code after a scanner outage or candidate analysis outage',async()=>{
  const f=await fixture();f.diagnose.mockRejectedValueOnce(new Error('private scanner failure'));
  await expect(f.service().generate(f.id,{baseAssetId:'source'})).rejects.toThrow('静态诊断执行失败');
  f.analyzer.mockRejectedValueOnce(new Error('private model failure'));
  await expect(f.service().generate(f.id,{baseAssetId:'source'})).rejects.toThrow('分析候选能力');
  await f.service().generate(f.id,{baseAssetId:'source'});
  expect(f.generate).toHaveBeenCalledTimes(1);expect(f.pack).toHaveBeenCalledTimes(1);expect(f.skills.uploadZip).toHaveBeenCalledTimes(1);
  expect(f.diagnose).toHaveBeenCalledTimes(2);expect(f.analyzer).toHaveBeenCalledTimes(2);expect(f.review).toHaveBeenCalledTimes(1);
});

it('refuses a checkpoint belonging to another artifact without invoking the review model',async()=>{
  const f=await fixture();f.review.mockRejectedValueOnce(new Error('private error'));
  await expect(f.service().generate(f.id,{baseAssetId:'source'})).rejects.toThrow();
  const saved=await f.store.get(f.id);saved.generationAttempts![0]!.inspectionCheckpoint!.inspection!.assetDigest='f'.repeat(64);
  await f.store.save(saved);
  await expect(f.service().generate(f.id,{baseAssetId:'source'})).rejects.toThrow('检查点与实际资产不匹配');
  expect(f.review).toHaveBeenCalledTimes(1);expect((await f.store.get(f.id)).candidate).toBeNull();
});

it('does not consider a completed checkpoint current after a newly confirmed design',async()=>{
  const f=await fixture(),done=await f.service().generate(f.id,{baseAssetId:'source'});
  await expect(f.service().generate(f.id,{baseAssetId:done.candidate!.assetId})).resolves.toMatchObject({candidate:{assetId:done.candidate!.assetId}});
  const proposal=await f.planning.propose(f.id);await f.planning.approve(f.id,{proposalId:proposal.proposalId,inputDigest:proposal.inputDigest});
  await expect(f.service().generate(f.id,{baseAssetId:done.candidate!.assetId})).rejects.toThrow('已变化');
  expect(f.generate).toHaveBeenCalledTimes(1);
});
