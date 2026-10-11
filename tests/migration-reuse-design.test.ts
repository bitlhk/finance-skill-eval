import {expect,it,vi} from 'vitest';
import {strToU8} from 'fflate';
import {MigrationPlanningService} from '../src/migration/application/migration-planning-service.js';
import {MigrationCandidateInspectionService} from '../src/migration/application/migration-candidate-inspection-service.js';
import {projectMigrationPlan,currentReuseProposal,reuseReviewIssues,evidenceIssues,reuseDesignSchema,reuseReviewSchema,type ReuseDesign} from '../src/migration/domain/migration-reuse-design.js';
import type {MigrationProject} from '../src/migration/domain/migration-project.js';
import type {MigrationProjectStore} from '../src/migration/application/migration-project-store.js';
import type {MigrationSkillRepository} from '../src/migration/application/migration-skill-repository.js';
import type {MigrationReusePlanner} from '../src/migration/application/migration-reuse-planner.js';
import {inspectionFixture,toolFixture,SKILL_MD} from './analysis-fixture.js';
import {reusePlannerFixture} from './reuse-design-fixture.js';
import {createReusePlanner,normalizeReuseRepresentation} from '../src/migration/infrastructure/migration-reuse-planner.js';
import {MigrationEvaluationService} from '../src/migration/application/migration-evaluation-service.js';
import {MigrationSuiteService} from '../src/migration/application/migration-suite-service.js';
import {reuseModelContext} from '../src/migration/infrastructure/migration-reuse-context.js';
import type {ReusePlannerTelemetry} from '../src/migration/domain/migration-reuse-telemetry.js';
import {OpenAiCompatibleModelAdapter} from '../src/openai-compatible-model.js';
import {ModelCompletionError} from '../src/openai-compatible-model.js';
import {MigrationGenerationService} from '../src/migration/application/migration-generation-service.js';
import {reuseExecutionContract} from '../src/migration/domain/migration-reuse-execution-contract.js';
import {canonicalSha256} from '../src/shared/json-canonicalization.js';

const sourceFiles={'SKILL.md':SKILL_MD,'scripts/lookup.py':'def lookup(account_id): return {"amount": 10}\n'};
it.each(['MODEL_NETWORK_ERROR','MODEL_HTTP_ERROR','MODEL_OUTPUT_TRUNCATED','MODEL_EMPTY_RESPONSE'] as const)('preserves safe review failure classification %s without retry or private details',async code=>{
  const ctx=context(),proposal=await ctx.service.propose('migration-fixture');
  const complete=vi.fn(async()=>{throw new ModelCompletionError(code,'PRIVATE_PROVIDER_DETAILS')});
  const traces:ReusePlannerTelemetry[]=[];
  const planner=createReusePlanner({adapterId:'test',complete},{providerId:'test',modelId:'test',parameters:{}},undefined,async trace=>{traces.push(trace)});
  const failure=await planner({mode:'REVIEW',sourceFiles,candidateFiles:sourceFiles,sourceInspection:ctx.get().inspection!,candidateInspection:ctx.get().inspection!,design:proposal.design}).catch(error=>error);
  expect(failure.failure).toMatchObject({phase:'PLAN_REVIEW',code,recoverable:true});
  expect(failure.message).not.toContain('PRIVATE_PROVIDER_DETAILS');
  expect(complete).toHaveBeenCalledTimes(1);
  expect(traces.at(-1)?.failureCode).toBe(code);
  expect(JSON.stringify(traces)).not.toContain('PRIVATE_PROVIDER_DETAILS');
});
function context(planner:MigrationReusePlanner=reusePlannerFixture){
  const inspection=inspectionFixture([toolFixture({name:'lookup',sourcePaths:['scripts/lookup.py'],portability:'PORTABLE_SCRIPT',kind:'SCRIPT'})],'source');
  inspection.assetDigest='a'.repeat(64);
  inspection.dependencyAnalysis={status:'COMPLETE',revision:0,materialsDigest:'fixture',dependencies:[],chains:[],rejectedClaims:0};
  const asset={schemaVersion:'finance.skill-eval.skill-asset.v1' as const,assetId:'source',skillId:'fixture-skill',version:'1',displayName:'test',description:'test',sourceType:'uploaded',artifactSha256:inspection.assetDigest,skillFile:'SKILL.md',fileCount:2,createdAt:'now'};
  let project:MigrationProject={schemaVersion:'finance.skill-migration.v2',id:'migration-fixture',name:'test',createdAt:'now',source:asset,candidate:null,candidateNotes:'',runs:[],assessment:'NOT_VALIDATED',inspection,sourceInspection:structuredClone(inspection),decisions:[{toolId:inspection.tools[0]!.toolId,form:'SCRIPT',language:'python',reason:'reuse',baseAssetId:'source',decidedAt:'now'}]};
  const store={get:async()=>structuredClone(project),save:async(value:MigrationProject)=>{project=structuredClone(value)},runExclusive:async(_id:string,fn:()=>Promise<unknown>)=>fn()} as MigrationProjectStore;
  const skills={readArchive:async()=>Object.fromEntries(Object.entries(sourceFiles).map(([name,text])=>[name,strToU8(text)]))} as MigrationSkillRepository;
  const service=new MigrationPlanningService(store,{serialize:()=>null},undefined,planner,skills);
  return {service,store,get:()=>project};
}

it('requires an evidence-backed approved design and invalidates it when choices or source facts change',async()=>{
  const ctx=context();
  expect(projectMigrationPlan(ctx.get())?.generationAllowed).toBe(false);
  const proposal=await ctx.service.propose('migration-fixture');
  expect(projectMigrationPlan(ctx.get())?.generationAllowed).toBe(false);
  await ctx.service.approve('migration-fixture',{proposalId:proposal.proposalId,inputDigest:proposal.inputDigest});
  expect(projectMigrationPlan(ctx.get())?.generationAllowed).toBe(true);
  // Saving an identical choice must not invalidate confirmation merely due to its timestamp.
  await ctx.service.decide('migration-fixture',ctx.get().inspection!.tools[0]!.toolId,{form:'SCRIPT',language:'python',baseAssetId:'source'});
  expect(projectMigrationPlan(ctx.get())?.generationAllowed).toBe(true);
  await ctx.service.decide('migration-fixture',ctx.get().inspection!.tools[0]!.toolId,{form:'MCP',language:'python',baseAssetId:'source'});
  expect(projectMigrationPlan(ctx.get())?.generationAllowed).toBe(false);
  await expect(ctx.service.approve('migration-fixture',{proposalId:proposal.proposalId,inputDigest:proposal.inputDigest})).rejects.toThrow('已变化');
});

it('blocks material unknowns but permits a design before test credentials are provided',async()=>{
  const ctx=context(async input=>{
    const result=await reusePlannerFixture(input) as {design:ReuseDesign};
    result.design.unresolvedQuestions=['原工具跨轮数据的隔离范围未明确'];return result;
  });
  const proposal=await ctx.service.propose('migration-fixture');
  await expect(ctx.service.approve('migration-fixture',{proposalId:proposal.proposalId,inputDigest:proposal.inputDigest})).rejects.toThrow('隔离范围');
  // No runtime configuration or real values exist in this fixture.
  const complete=context(),ready=await complete.service.propose('migration-fixture');
  await expect(complete.service.approve('migration-fixture',{proposalId:ready.proposalId,inputDigest:ready.inputDigest})).resolves.toHaveProperty('approvedAt');
});

it('gives planning the same delivery boundaries used by implementation instead of inventing configuration',async()=>{
  const ctx=context(async input=>{
    if(input.mode==='PROPOSE'){
      expect(input.executionContract).toEqual(reuseExecutionContract);
      expect(input.deliveryContract).toMatchObject({script:{cwd:'WORKSPACE'},mcp:{transport:'STREAMABLE_HTTP',
        launcher:{portEnvironment:'PORT',requiresBusinessDependencyDeclaration:false},
        workspaceContext:{header:'X-Workspace-Root',scope:'PER_REQUEST_WORKSPACE',requiresDependencyDeclaration:false,
          rootMeaning:'ORIGINAL_EXECUTION_CWD',relativeBusinessPaths:'PRESERVE_SOURCE_RELATIVE_PATHS_UNDER_WORKSPACE_ROOT'},
        pythonFramework:{package:'fastmcp',version:'2.14.7'}}});
      expect(JSON.stringify(input.deliveryContract)).toContain('model-executed business workflow');
    }
    return reusePlannerFixture(input);
  });
  await expect(ctx.service.propose('migration-fixture')).resolves.toHaveProperty('design');
});

it('does not silently carry confirmation from before the acceptance-executor contract was bound',async()=>{
  const ctx=context(),proposal=await ctx.service.propose('migration-fixture');
  await ctx.service.approve('migration-fixture',{proposalId:proposal.proposalId,inputDigest:proposal.inputDigest});
  const project=ctx.get(),inspection=project.sourceInspection!;
  const {inspectedAt:_,reuseConformance:__,...facts}=inspection;
  project.reuseProposal!.inputDigest=canonicalSha256({sourceDigest:project.source.artifactSha256,facts,
    decisions:project.decisions!.map(({toolId,form,language})=>({toolId,form,language})).sort((a,b)=>a.toolId.localeCompare(b.toolId))});
  expect(currentReuseProposal(project)).toBeNull();
  expect(projectMigrationPlan(project)?.generationAllowed).toBe(false);
});

it('guides planning with observable execution boundaries and blocks declared unmet requirements before confirmation',async()=>{
  const complete=vi.fn(async request=>{
    expect(request.messages[0].content).toContain('不得假设 Eval 能在轮次之间删除文件');
    const modelInput=JSON.parse(request.messages[1].content);
    expect(modelInput.executionContract.workspace.betweenTurns).toContain('no file-write/delete');
    const proposed=await reusePlannerFixture(modelInput) as {design:ReuseDesign};
    proposed.design.unresolvedQuestions=['原承诺需要在轮次之间删除文件，但执行契约未提供该操作'];
    return {content:JSON.stringify(proposed),modelId:'controlled-test'};
  });
  const ctx=context(createReusePlanner({adapterId:'controlled-test',complete},
    {providerId:'test',modelId:'test',parameters:{}}));
  const proposal=await ctx.service.propose('migration-fixture');
  await expect(ctx.service.approve('migration-fixture',{proposalId:proposal.proposalId,inputDigest:proposal.inputDigest})).rejects.toThrow('删除文件');
  expect(complete).toHaveBeenCalledTimes(1);
});

it('rejects invented source evidence instead of accepting the model reuse assertion',async()=>{
  const ctx=context(async input=>{
    const result=await reusePlannerFixture(input) as {design:ReuseDesign};
    result.design.changes[0]!.evidence=[{path:'scripts/lookup.py',snippet:'a hidden session mechanism that is not in this file'}];return result;
  });
  await expect(ctx.service.propose('migration-fixture')).rejects.toThrow('无法定位');
});

it('separates optional delivery capabilities from actual Skill dependencies and unresolved blockers',async()=>{
  const ctx=context(),input={mode:'PROPOSE' as const,sourceFiles,inspection:ctx.get().inspection!,toolPlan:projectMigrationPlan(ctx.get())!};
  const correct=await reusePlannerFixture(input);
  let instruction='';
  const planner=createReusePlanner({adapterId:'test',complete:async request=>{instruction=request.messages[0]!.content;return {content:JSON.stringify(correct),modelId:'test'}}},{providerId:'test',modelId:'test',parameters:{}});
  await planner(input);
  expect(instruction).toContain('不代表所有 Script 都需要该 Header');
  expect(instruction).toContain('JSON stdin/stdout 契约');
  expect(instruction).toContain('确有新增宿主能力或契约缺口仍须如实阻塞');
});
it('resolves unique Skill-root citations but rejects ambiguous files and invented snippets',()=>{
  const evidence=[{path:'assets/rules.json',snippet:'{"limit":100}'}];
  expect(evidenceIssues(evidence,{'skill/assets/rules.json':'{"limit":100}'})).toEqual([]);
  expect(evidence[0]!.path).toBe('skill/assets/rules.json');
  expect(evidenceIssues([{path:'rules.json',snippet:'{"limit":100}'}],{'skill/assets/rules.json':'{"limit":100}','other/rules.json':'{"limit":100}'})).not.toEqual([]);
  expect(evidenceIssues([{path:'assets/rules.json',snippet:'{"limit":200}'}],{'skill/assets/rules.json':'{"limit":100}'})).not.toEqual([]);
});

it('re-reads source to repair invalid evidence with bounded attempts without weakening matching',async()=>{
  const ctx=context(),input={mode:'PROPOSE' as const,sourceFiles,inspection:ctx.get().inspection!,toolPlan:projectMigrationPlan(ctx.get())!};
  const correct=await reusePlannerFixture(input) as {status:string;design:ReuseDesign};
  const wrong=structuredClone(correct);wrong.design.changes[0]!.evidence[0]!.snippet='invented code';
  const calls:any[]=[];
  const planner=createReusePlanner({adapterId:'controlled-output',complete:async request=>{
    calls.push(structuredClone(request));return {content:JSON.stringify(calls.length===1?wrong:correct),modelId:'fixture'};
  }},{modelId:'fixture',providerId:'fixture',parameters:{}});
  await expect(planner(input)).resolves.toMatchObject({...correct,design:reuseDesignSchema.parse(correct.design)});
  expect(calls).toHaveLength(2);expect(calls.every(call=>call.toolFree)).toBe(true);
  expect(calls[1].messages.at(-1).content).toContain('validationErrors');
  let rejectedCalls=0;
  const rejected=createReusePlanner({adapterId:'controlled-output',complete:async()=>{rejectedCalls++;return {content:JSON.stringify(wrong),modelId:'fixture'}}},{modelId:'fixture',providerId:'fixture',parameters:{}});
  await expect(rejected(input)).rejects.toThrow('依据无法核实');expect(rejectedCalls).toBe(3);
});

it('sends unchanged source only once but retains all paths and changed or hidden code',async()=>{
  const ctx=context(),proposal=await ctx.service.propose('migration-fixture');
  const input={mode:'REVIEW' as const,sourceFiles,candidateFiles:{'skill/SKILL.md':sourceFiles['SKILL.md'],'scripts/lookup.py':sourceFiles['scripts/lookup.py'],'hidden.py':'import private_state'},
    sourceInspection:ctx.get().inspection!,candidateInspection:ctx.get().inspection!,design:proposal.design};
  const compact=reuseModelContext(input);
  expect(JSON.stringify(compact)).toContain('import private_state');
  if(!('sharedFiles' in compact))throw new Error('Review context expected');
  expect(compact.sharedFiles.find(file=>file.sourcePaths.includes('SKILL.md'))?.candidatePaths).toEqual(['skill/SKILL.md']);
  expect(compact.sharedFiles.find(file=>file.sourcePaths.includes('SKILL.md'))?.content).toBe(sourceFiles['SKILL.md']);
  expect(compact.sharedFiles.find(file=>file.sourcePaths.includes('scripts/lookup.py'))?.content).toBe(sourceFiles['scripts/lookup.py']);
  expect(compact.changedCandidateFiles).toEqual([{path:'hidden.py',sourcePath:null,content:'import private_state'}]);
  expect('sourceInspection' in compact).toBe(false);expect('sourceFacts' in compact).toBe(true);
});

it('bounds review repair to one retry and records timings, usage and the exact retry category',async()=>{
  const ctx=context(),proposal=await ctx.service.propose('migration-fixture');
  const input={mode:'REVIEW' as const,sourceFiles,candidateFiles:sourceFiles,sourceInspection:ctx.get().inspection!,candidateInspection:ctx.get().inspection!,design:proposal.design};
  const valid=await reusePlannerFixture(input);
  const remote=new OpenAiCompatibleModelAdapter({apiKey:'private-key',baseUrl:'http://127.0.0.1:1'});
  const call=vi.spyOn(remote,'complete').mockResolvedValueOnce({content:'not JSON',modelId:'fixture'})
    .mockResolvedValue({content:JSON.stringify(valid),modelId:'fixture',usage:{inputTokens:100,outputTokens:20,totalTokens:120}});
  const recorded:ReusePlannerTelemetry[]=[];
  const planner=createReusePlanner(remote,{modelId:'fixture',providerId:'fixture',parameters:{}},undefined,async trace=>{recorded.push(trace)});
  const result=await planner(input) as {telemetry:ReusePlannerTelemetry};
  expect(call).toHaveBeenCalledTimes(2);expect(call.mock.calls.every(([req])=>!req.requestId.includes('-format-'))).toBe(true);
  expect(result.telemetry.status).toBe('COMPLETED');expect(result.telemetry.calls[0]!.retryReason).toBe('OUTPUT_FORMAT');
  expect(result.telemetry.calls[1]!.usage?.totalTokens).toBe(120);
  expect(recorded.some(trace=>trace.calls.some(c=>c.status==='RUNNING'))).toBe(true);
  expect(JSON.stringify(recorded)).not.toContain('private-key');expect(JSON.stringify(recorded)).not.toContain('snippet');
  call.mockClear().mockResolvedValue({content:'not JSON',modelId:'fixture'});
  await expect(planner(input)).rejects.toThrow('无法解析');expect(call).toHaveBeenCalledTimes(2);
  expect(recorded.at(-1)?.status).toBe('FAILED');expect(recorded.at(-1)?.failureCode).toBe('PLANNER_FAILED');
});

it('normalizes single-item collections and casing without inventing missing design facts',()=>{
  expect(normalizeReuseRepresentation({status:'proposed',design:{conditions:'Install declared requirements',changes:{id:'one',toolNames:'lookup',evidence:{path:'source.py',snippet:'true code'}}}}))
    .toEqual({status:'PROPOSED',design:{conditions:['Install declared requirements'],changes:[{id:'one',toolNames:['lookup'],evidence:[{path:'source.py',snippet:'true code'}]}]}});
  expect(normalizeReuseRepresentation({status:'PROPOSED',design:{}})).toEqual({status:'PROPOSED',design:{}});
});

it('reports actionable nested review fields to correction and telemetry without storing received values',async()=>{
  const ctx=context(),proposal=await ctx.service.propose('migration-fixture');
  const input={mode:'REVIEW' as const,sourceFiles,candidateFiles:sourceFiles,sourceInspection:ctx.get().inspection!,candidateInspection:ctx.get().inspection!,design:proposal.design};
  const valid=await reusePlannerFixture(input) as any,invalid=structuredClone(valid);
  invalid.review.changes[0].status='private-source-string';invalid.review.changes[0].reason={secret:'do-not-log'};
  const requests:any[]=[],traces:ReusePlannerTelemetry[]=[];
  const planner=createReusePlanner({adapterId:'test',complete:async request=>{requests.push(request);return {content:JSON.stringify(requests.length===1?invalid:valid),modelId:'test'}}},{providerId:'test',modelId:'test',parameters:{}},undefined,async trace=>{traces.push(trace)});
  const result=await planner(input) as any;
  expect(result.status).toBe('REVIEWED');expect(requests).toHaveLength(2);
  const feedback=JSON.parse(requests[1].messages.at(-1).content).validationErrors;
  expect(feedback).toContain('review.changes.0.status (invalid_enum_value)');
  expect(feedback).toContain('review.changes.0.reason (invalid_type; expected string)');
  expect(feedback).not.toContain('Invalid input');
  expect(result.telemetry.calls[0].validationFields).toContain('review.changes.0.status (invalid_enum_value)');
  expect(JSON.stringify(traces)).not.toContain('private-source-string');expect(JSON.stringify(traces)).not.toContain('do-not-log');
});

it('rejects the other lifecycle result type even when its schema is otherwise valid',async()=>{
  const ctx=context(),proposal=await ctx.service.propose('migration-fixture');
  const input={mode:'REVIEW' as const,sourceFiles,candidateFiles:sourceFiles,sourceInspection:ctx.get().inspection!,candidateInspection:ctx.get().inspection!,design:proposal.design};
  const complete=vi.fn(async()=>({content:JSON.stringify({status:'PROPOSED',design:proposal.design}),modelId:'test'}));
  const traces:ReusePlannerTelemetry[]=[];
  await expect(createReusePlanner({adapterId:'test',complete},{providerId:'test',modelId:'test',parameters:{}},undefined,async trace=>{traces.push(trace)})(input)).rejects.toThrow('expected REVIEWED or ABSTAINED');
  expect(complete).toHaveBeenCalledTimes(2);expect(traces.at(-1)?.calls.at(-1)?.validationFields).toEqual(['status (expected REVIEWED or ABSTAINED)']);
});

it('does not retry a semantic rejection into approval and records cancellation without calling the model',async()=>{
  const ctx=context(),proposal=await ctx.service.propose('migration-fixture');
  const input={mode:'REVIEW' as const,sourceFiles,candidateFiles:sourceFiles,sourceInspection:ctx.get().inspection!,candidateInspection:ctx.get().inspection!,design:proposal.design};
  const rejected=await reusePlannerFixture(input) as any;
  rejected.review.changes[0].status='NEEDS_CHANGES';rejected.review.semanticIssues=['Behavior drift'];
  const complete=vi.fn(async()=>({content:JSON.stringify(rejected),modelId:'fixture'}));
  const traces:ReusePlannerTelemetry[]=[];
  const adapter={adapterId:'controlled-output',complete},model={modelId:'fixture',providerId:'fixture',parameters:{}};
  await expect(createReusePlanner(adapter,model)(input)).resolves.toMatchObject({status:'REVIEWED',review:reuseReviewSchema.parse(rejected.review)});
  expect(complete).toHaveBeenCalledTimes(1);
  expect(reuseReviewIssues(rejected.review,proposal.design,sourceFiles)).not.toEqual([]);
  // Bad citations do not authorize rewriting an already negative verdict.
  rejected.review.changes[0].evidence=[{path:'invented.py',snippet:'invented'}];
  complete.mockClear();
  await expect(createReusePlanner(adapter,model)(input)).resolves.toMatchObject({status:'REVIEWED',review:{semanticIssues:['Behavior drift']}});
  expect(complete).toHaveBeenCalledTimes(1);
  const reviewPrompt=complete.mock.calls[0] as unknown as [{messages:Array<{content:string}>}];
  expect(reviewPrompt[0].messages[0]!.content).not.toContain('"status":"CONFORMING|NEEDS_CHANGES|UNKNOWN"');
  complete.mockClear();
  await expect(createReusePlanner(adapter,model,AbortSignal.abort(),async trace=>{traces.push(trace)})(input)).rejects.toThrow();
  expect(complete).not.toHaveBeenCalled();expect(traces.at(-1)).toMatchObject({status:'FAILED',failureCode:'TIME_LIMIT',calls:[]});
});

it('preserves proposal-only shared format repair through the telemetry wrapper',async()=>{
  const ctx=context(),input={mode:'PROPOSE' as const,sourceFiles,inspection:ctx.get().inspection!,toolPlan:projectMigrationPlan(ctx.get())!};
  const valid=await reusePlannerFixture(input) as {status:string;design:ReuseDesign};
  const remote=new OpenAiCompatibleModelAdapter({apiKey:'private-key',baseUrl:'http://127.0.0.1:1'});
  const call=vi.spyOn(remote,'complete').mockResolvedValueOnce({content:'not JSON',modelId:'fixture'})
    .mockResolvedValue({content:JSON.stringify(valid),modelId:'fixture'});
  await expect(createReusePlanner(remote,{modelId:'fixture',providerId:'fixture',parameters:{}})(input)).resolves.toMatchObject({...valid,design:reuseDesignSchema.parse(valid.design)});
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls[1]![0].requestId).toContain('-format-');
});

it('uses one deadline for proposal retries and does not call a model after cancellation',async()=>{
  const ctx=context();let calls=0;
  const planner=createReusePlanner({adapterId:'cancelled',complete:async()=>{calls++;return {content:'{}',modelId:'fixture'}}},
    {modelId:'fixture',providerId:'fixture',parameters:{}},AbortSignal.abort());
  await expect(planner({mode:'PROPOSE',sourceFiles,inspection:ctx.get().inspection!,toolPlan:projectMigrationPlan(ctx.get())!})).rejects.toThrow();
  expect(calls).toBe(0);
});

it('requires every approved change to have candidate evidence and preserves actual candidate contracts',async()=>{
  const ctx=context(),proposal=await ctx.service.propose('migration-fixture');
  const approved=await ctx.service.approve('migration-fixture',{proposalId:proposal.proposalId,inputDigest:proposal.inputDigest});
  const source=ctx.get().inspection!,candidate={...ctx.get().source,assetId:'candidate',artifactSha256:'b'.repeat(64)};
  const actual=structuredClone(source);actual.assetId=candidate.assetId;actual.assetDigest=candidate.artifactSha256;
  actual.tools[0]!.inputSchema={type:'object',properties:{account_id:{type:'string'}}};
  actual.tools[0]!.findings=[{code:'ACTUAL_NOTE',severity:'INFO',path:'scripts/lookup.py',line:1,message:'Actual candidate fact'}];
  actual.dependencyAnalysis!.dependencies=[];
  source.dependencyAnalysis!.dependencies.push({key:'old-identity-sdk',action:'MOVE_TO_RUNTIME'} as any);
  const diagnose=vi.fn(async()=>({digest:candidate.artifactSha256,status:'COMPLETE',coverage:[],findings:[],ai:{status:'NOT_REQUESTED'},scannerDigest:'c'.repeat(64)}));
  const inspectionService=new MigrationCandidateInspectionService({diagnose} as any,{
    analyzer:async()=>({status:'PRODUCED',payload:{}}),results:{inspection:()=>structuredClone(actual)} as any,
    dependencies:{analyze:()=>structuredClone(actual.dependencyAnalysis!)},reusePlanner:async input=>{
      if(input.mode==='REVIEW')expect(reuseModelContext(input)).toHaveProperty('deliveryContract.mcp.launcher.portEnvironment','PORT');
      return reusePlannerFixture(input);
    },
  });
  const phases:string[]=[];
  const result=await inspectionService.inspect({candidate,files:Object.fromEntries(Object.entries(sourceFiles).map(([name,text])=>[name,strToU8(text)])),inspection:source,
    decisions:ctx.get().decisions!,baseAssetId:'source',generations:[],reuseProposal:approved,sourceFiles,onPhase:phase=>phases.push(phase)});
  expect(phases).toEqual(['STATIC_SCAN','CANDIDATE_ANALYSIS','PLAN_REVIEW']);
  expect(result.tools[0]!.inputSchema).toEqual(actual.tools[0]!.inputSchema);
  expect(diagnose).toHaveBeenCalledWith(candidate,false,{explain:false});
  expect(result.tools[0]!.findings[0]!.code).toBe('ACTUAL_NOTE');
  expect(result.dependencyAnalysis!.dependencies).toEqual([]);
  expect(result.reuseConformance?.acceptanceChecks).toEqual([{checkId:'behavior',status:'NOT_RUN'}]);
  expect(reuseReviewIssues({changes:[],unexpectedDependencies:[],semanticIssues:[]},approved.design,sourceFiles)).not.toEqual([]);
  actual.tools[0]!.portability='RUNTIME_BOUND';
  await expect(inspectionService.inspect({candidate,files:Object.fromEntries(Object.entries(sourceFiles).map(([name,text])=>[name,strToU8(text)])),inspection:source,
    decisions:ctx.get().decisions!,baseAssetId:'source',generations:[]})).rejects.toThrow('尚未确认解除');
});

it('persists generation stage history and clears the active failure when recovery completes',async()=>{
  const ctx=context();
  const staticAnalysis={status:'COMPLETE' as const,dependencyStatus:'NO_BINDING_IN_CHECKED_SCOPE',incompleteFiles:[]};
  ctx.get().inspection!.staticAnalysis=staticAnalysis;ctx.get().sourceInspection!.staticAnalysis=staticAnalysis;
  const proposal=await ctx.service.propose('migration-fixture');
  await ctx.service.approve('migration-fixture',{proposalId:proposal.proposalId,inputDigest:proposal.inputDigest});
  const archive=Object.fromEntries(Object.entries(sourceFiles).map(([name,text])=>[name,strToU8(text)]));
  const skills={readArchive:async()=>archive,uploadZip:async()=>({...ctx.get().source,assetId:'candidate'})} as any;
  let release!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve}),entered=Promise.withResolvers<void>();
  const generate=vi.fn(async()=>{entered.resolve();await waiting;throw new Error('private provider error')});
  const service=new MigrationGenerationService(ctx.store,skills,{get:async()=>({items:[]}),digest:()=> 'fixture'} as any,
    {package:()=>({files:archive,generations:[],diff:[]})} as any,{generate} as any,
    {inspect:async(input:any)=>{input.onPhase('STATIC_SCAN');input.onPhase('CANDIDATE_ANALYSIS');input.onPhase('PLAN_REVIEW');return ctx.get().inspection}} as any);
  expect(await service.executionProgress('migration-fixture')).toBeNull();
  const failed=service.generate('migration-fixture',{baseAssetId:'source'});failed.catch(()=>{});
  await Promise.race([entered.promise,failed]);
  const pending=await service.executionProgress('migration-fixture');
  expect(pending?.status).toBe('RUNNING');expect(pending?.steps.at(-1)?.phase).toBe('GENERATING');
  pending!.steps.length=0;expect((await service.executionProgress('migration-fixture'))?.steps.length).toBe(2);
  release();await expect(failed).rejects.toThrow('已保存完成阶段');
  const failure=await service.executionProgress('migration-fixture');
  expect(failure?.status).toBe('FAILED');expect(failure?.finishedAt).toBeTruthy();expect(JSON.stringify(failure)).not.toContain('private provider error');
  generate.mockImplementationOnce(async()=>({generationStats:{agentAttempts:1,outputCorrectionAttempts:0}}) as never);
  await service.generate('migration-fixture',{baseAssetId:'source'});
  const completed=await service.executionProgress('migration-fixture');expect(completed?.status).toBe('COMPLETED');
  expect(completed?.steps.map(step=>step.phase)).toEqual(['PREPARING','GENERATING','PREPARING','GENERATING','PACKAGING','STATIC_SCAN','CANDIDATE_ANALYSIS','PLAN_REVIEW']);
  expect(completed?.steps[1]?.status).toBe('FAILED');
});

it('keeps supplemented source available during optimization review and rejects changed materials',async()=>{
  const ctx=context(),project=ctx.get();
  let digest='fixture';
  const service=new MigrationCandidateInspectionService(undefined,{
    analyzer:async()=>null,results:{} as any,dependencies:{} as any,reusePlanner:reusePlannerFixture,
    skills:{readArchive:async()=>({'SKILL.md':strToU8(SKILL_MD)})} as MigrationSkillRepository,
    supplements:{get:async()=>({revision:1,items:[{files:{'supplements/context.py':Buffer.from('def lookup(): pass').toString('base64')}}] as any}),digest:()=>digest} as any,
  });
  await expect(service.sourceFiles(project)).resolves.toHaveProperty('supplements/context.py','def lookup(): pass');
  digest='changed';await expect(service.sourceFiles(project)).rejects.toThrow('补充材料已变化');
});

it('does not label an old candidate run as implementing a newly confirmed reuse proposal',async()=>{
  const ctx=context(),proposal=await ctx.service.propose('migration-fixture');
  await ctx.service.approve('migration-fixture',{proposalId:proposal.proposalId,inputDigest:proposal.inputDigest});
  const project=await ctx.store.get('migration-fixture');project.candidate=project.source;
  project.candidateReuseProposalId='previous-proposal';await ctx.store.save(project);
  const evaluation=new MigrationEvaluationService(ctx.store,{} as any,{} as any);
  const variant={mode:'skill_version',skillId:project.source.skillId,version:project.source.version,artifactSha256:project.source.artifactSha256};
  await expect(evaluation.validate('migration-fixture',{pair:'BC',dataSnapshot:'snapshot',permissionBasis:'read-only',sourceProjectRef:'source',dependencyLockRef:'lock',
    configuration:{packId:'fixture',runtime:{type:'runtime_launcher',environmentId:'launcher'},executionModel:{modelId:'fixture',providerId:'fixture',parameters:{}},judgeMode:'model',
      evaluationMode:'candidate_assessment',leftVariant:variant,rightVariant:variant,runtimeBindings:{left:{environmentId:'launcher',skillAssetId:project.source.assetId},right:{environmentId:'launcher',skillAssetId:project.source.assetId}}}})).rejects.toThrow('尚未落实');
});

it('includes only the current approved reuse acceptance requirements in generated suites',async()=>{
  const ctx=context(),proposal=await ctx.service.propose('migration-fixture');
  await ctx.service.approve('migration-fixture',{proposalId:proposal.proposalId,inputDigest:proposal.inputDigest});
  const prompts:string[]=[];
  const service=new MigrationSuiteService(ctx.store,{readArchive:async()=>({'SKILL.md':strToU8(SKILL_MD)})} as MigrationSkillRepository,
    async()=>null,async input=>{prompts.push(input.skillSource);return {summary:'test',cases:[]}},{} as any,
    {create:async()=>({preparationId:'suite'}),get:async()=>null} as any);
  await service.generate('migration-fixture',{baseAssetId:'source'});
  expect(prompts[0]).toContain('已确认迁移方案的验收要求');
  expect(prompts[0]).toContain('设计要求，不代表已经通过');
  await ctx.service.decide('migration-fixture',ctx.get().inspection!.tools[0]!.toolId,{form:'MCP',language:'python',baseAssetId:'source'});
  await service.generate('migration-fixture',{baseAssetId:'source'});
  expect(prompts[1]).not.toContain('已确认迁移方案的验收要求');
});
