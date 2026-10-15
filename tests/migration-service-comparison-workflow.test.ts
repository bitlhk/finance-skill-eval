import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {MigrationStore} from '../src/migration/migration-store.js';
import {SkillStore} from '../src/service/skill-store.js';
import {PreparationStore} from '../src/service/preparation-store.js';
import {analysisFixture} from './analysis-fixture.js';
import {originalServiceFingerprint,originalServiceSchema} from '../src/original-service-runtime.js';
import {runtimeExecutionEvidenceSchema} from '../src/contracts.js';
it('freezes original-service/candidate bindings, distinguishes baseline capture from Runtime attestation, and invalidates changed candidates',async()=>{
 const data=await mkdtemp(path.join(os.tmpdir(),'migration-service-'));
 try{
  const skills=new SkillStore(data);await skills.initialize();const preparations=new PreparationStore(data);await preparations.initialize();
  const upload=(version:string)=>skills.uploadZip(Buffer.from(zipSync({'SKILL.md':strToU8(`---\nname: balance-test\nversion: ${version}\ndescription: 账户余额问答，用于企业查询。\n---\n回答账户余额，失败时不要编造。\n`)})));
  const source=await upload('1.0.0'),candidate=await upload('2.0.0');let configuration:any,report:any;
  const environment={environmentId:'runtime',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:'http://127.0.0.1:1/'};
  const store=new MigrationStore(data,{skills,runs:{create:async(config:unknown)=>{configuration=config;return {jobId:'job'}}} as any,
   jobs:{get:()=>({status:'completed',configuration,report})} as any,catalog:{get:()=>null} as any,preparations,environments:{get:async()=>environment} as any,
   analyzer:analysisFixture([]),suiteGenerator:async()=>({summary:'AI 冻结测试集',cases:[{caseId:'generated',name:'generated',prompt:'查询余额',evaluationGoal:'余额为1000',requiredTools:['imaginary'],rubric:[{criterionId:'g',label:'余额',description:'余额为1000',dimension:'business_completeness',weight:1,required:true,allOf:['余额必须为1000'],anyOf:['余额'],noneOf:['未知']}],tags:[]} ]})});
  const project=await store.create({sourceAssetId:source.assetId,name:'原服务对比'});await store.inspect(project.id);await store.candidate(project.id,{assetId:candidate.assetId,notes:'候选'});await store.inspect(project.id);
  const suite=await store.importSimpleSuite(project.id,{name:'余额测试',cases:[{id:'balance',input:'查询余额',criteria:['余额为1000']} ],holdoutCases:[{id:'balance-holdout',input:'独立余额情境',criteria:['返回正确余额']} ]});
  expect(suite.holdoutCases?.map(item=>item.caseId)).toEqual(['balance-holdout']);
  const variant=(asset:typeof source)=>({mode:'skill_version',skillId:asset.skillId,version:asset.version,artifactSha256:asset.artifactSha256});
  const originalService=originalServiceSchema.parse({endpoint:'http://127.0.0.1:1234/run',requestTemplate:{message:'{{input}}'},responsePointer:'/answer'});
  const plan={pair:'SC',dataSnapshot:'冻结余额1000',permissionBasis:'只读测试账号',sourceProjectRef:'source',dependencyLockRef:'lock',configuration:{preparationId:suite.preparationId,runtime:{type:'runtime_launcher',environmentId:'runtime'},executionModel:{providerId:'test',modelId:'test',parameters:{}},judgeMode:'model',evaluationMode:'service_comparison',originalService,leftVariant:variant(source),rightVariant:variant(candidate),runtimeBindings:{left:{environmentId:'runtime',skillAssetId:source.assetId},right:{environmentId:'runtime',skillAssetId:candidate.assetId}}}};
  await store.validateOpenJiuwen(project.id,plan);
  expect(configuration.runtimeMcpBindings.left).toEqual([]);expect(configuration.leftVariant.artifactSha256).toBe(source.artifactSha256);
  const base={runId:'job',caseId:'balance',status:'completed',modelId:'test',skillVersion:'2',output:'余额为1000',elapsedMs:1,streamCompleted:true,error:null};
  report={cases:[{caseId:'balance',left:runtimeExecutionEvidenceSchema.parse({...base,side:'left',runtimeIdentityVerified:false,metadata:{baselineService:{configurationFingerprint:originalServiceFingerprint(originalService),sourceDigest:source.artifactSha256,responseDigest:'a'.repeat(64)}}}),right:runtimeExecutionEvidenceSchema.parse({...base,side:'right',runtimeIdentityVerified:true,metadata:{skillArtifactSha256:candidate.artifactSha256}}),judge:{serviceComparison:{verdict:'PASS',reason:'一致',checks:[]},dimensions:[]},judgeError:null}]};
  const result=await store.report(project.id);expect(result.experiments[0]!.evidence).toBe('SERVICE_BASELINE_AND_CANDIDATE_DIGEST_CHECKED');expect(result.verification.originalBaseline).toBe('CAPTURED');expect(result.experiments[0]!.acceptance.status).toBe('PASSED');
  const ai=await store.generateSuite(project.id,{baseAssetId:candidate.assetId,assessmentMode:'natural_language'});expect(ai.assessmentMode).toBe('natural_language');expect(ai.cases[0]!.requiredTools).toEqual(['imaginary']);expect(ai.cases[0]!.rubric[0]).toMatchObject({allOf:[],anyOf:[],noneOf:[]});
  const baselineOnly=await store.importSimpleSuite(project.id,{mode:'service_comparison',name:'只提供任务',cases:[{id:'baseline',input:'查询余额'}]});expect(baselineOnly.comparisonOnly).toBe(true);expect(baselineOnly.cases[0]!.rubric[0]!.description).toContain('原服务');
  await expect(store.validateOpenJiuwen(project.id,{...plan,pair:'BC',configuration:{...plan.configuration,preparationId:baselineOnly.preparationId,evaluationMode:'candidate_assessment',originalService:undefined,leftVariant:variant(candidate),runtimeBindings:{...plan.configuration.runtimeBindings,left:{environmentId:'runtime',skillAssetId:candidate.assetId}}}})).rejects.toThrow('以原服务为基线');
  await expect(store.validateOpenJiuwen(project.id,{...plan,pair:'BC'})).rejects.toThrow('SC');
  await store.candidate(project.id,{assetId:(await upload('3.0.0')).assetId,notes:'新候选'});expect((await store.report(project.id)).verification.originalBaseline).toBe('NOT_RUN');
 }finally{await rm(data,{recursive:true,force:true})}
});
