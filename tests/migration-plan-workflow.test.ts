import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';import {unzipSync} from 'fflate';
import {MigrationTaskService} from '../src/migration/tasks/application/task-service.js';
import {FileMigrationTaskRepository} from '../src/migration/tasks/infrastructure/task-repository.js';
import {bundleZip,type BundleAttempt,analysisSchema} from '../src/migration/tasks/domain/task-model.js';
import {standardCapabilities} from './runtime-standard-fixture.js';
import {legacyChangeCards,legacyPlanSections,proseParagraphs} from '../web/src/features/migration/legacy-plan.js';
// @ts-expect-error Shared fixture is used by the browser verification server.
import {fixtureAgent,readerCapability} from '../scripts/lib/migration-plan-fixture.mjs';
const cleanup:Array<()=>Promise<unknown>>=[];afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function setup(count=1){
  const root=await mkdtemp(path.join(os.tmpdir(),'plan-workflow-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const repo=new FileMigrationTaskRepository(root);const caps={...standardCapabilities('execution'),nativeToolNames:['read_file'],nativeCapabilities:[readerCapability]};
  const agent=vi.fn(fixtureAgent);const runtime=vi.fn(async()=>({runtime:{adapterId:'fixture',prepare:async()=>{},cleanup:async()=>{},execute:async()=>{throw Error('Not needed');}},model:{providerId:'fixture',modelId:'execution',parameters:{}},environmentSnapshot:{capabilities:caps}}));
  const service=new MigrationTaskService(repo,{get:async()=>null,readArchive:async()=>({})},agent,runtime,async()=>({passed:true,reason:'fixture'}));cleanup.push(()=>service.close());
  const files={...Object.fromEntries(Array.from({length:count},(_,i)=>[`skills/s${i}/SKILL.md`,Buffer.from(`---\nname: s${i}\ndescription: Preserve business ${i}\n---\nRead shared/rules.json.`).toString('base64')])),'shared/rules.json':Buffer.from('{"unit":"cents"}').toString('base64')};
  const task=await service.upload({},bundleZip(files));
  async function run(kind:BundleAttempt['kind'],extra={}){const t=await service.get(task.id);await service.start(t.id,kind,{key:randomUUID(),baseCandidateId:t.currentCandidateId,...extra});await vi.waitFor(async()=>expect((await service.get(t.id)).attempts.at(-1)?.status).not.toBe('RUNNING'));return service.get(t.id);}
  async function approve(){const t=await service.get(task.id);return service.approvePlan(t.id,{analysisDigest:t.currentPlanDigest});}
  return {root,repo,agent,runtime,caps,service,task,files,run,approve};
}
it.each([1,3,11])('uses one complete proposal and approval lifecycle for %i members',async count=>{
  const f=await setup(count);let task=await f.run('ANALYZE');
  expect(task.attempts.at(-1)?.status).toBe('COMPLETED');expect(task.analysis?.plan?.changes[1]?.memberIds).toHaveLength(count);
  expect(task.planApproved).toBe(false);await expect(f.service.start(task.id,'GENERATE',{key:'unapproved',baseCandidateId:null})).rejects.toThrow('确认');
  await f.approve();task=await f.run('GENERATE');expect(task.candidatePlanCurrent).toBe(true);
  const candidate=task.currentCandidateId;
  const archive=unzipSync(await f.service.export(task.id));expect(JSON.parse(Buffer.from(archive['migration/plan.json']!).toString()).analysis.plan.scope).toContain(String(count));
  await f.service.configure(task.id,{environmentId:'fixture',modelId:'execution',timeoutMs:10000,harnessTools:[]});
  task=await f.service.reviewRuntime(task.id);expect(task.runtimeReview?.status).toBe('PASSED');
  await f.service.checkRuntime(task.id);expect((await f.service.get(task.id)).startupCheckCurrent).toBe(true);
  const previous=structuredClone(task.analysis);
  task=await f.run('ANALYZE',{clarification:'保留审计说明'});
  expect(task.planRevisions).toHaveLength(2);expect(task.planRevisions?.[0]?.analysis).toEqual(previous);expect(task.planApproved).toBe(false);
  expect(task.candidatePlanCurrent).toBe(false);expect(task.currentCandidateId).toBe(candidate);expect(task.startupCheckCurrent).toBe(false);expect(task.runtimeReviewCurrent).toBe(false);
  expect(f.agent.mock.calls.at(-1)?.[0].clarification).toBe('保留审计说明');
  await expect(f.service.checkRuntime(task.id)).rejects.toThrow('旧方案');
  await f.approve();task=await f.run('GENERATE');expect(task.candidates).toHaveLength(2);expect(task.candidatePlanCurrent).toBe(true);
});
it('keeps unavailable and unverified environment requirements distinct',async()=>{
  const f=await setup();await f.run('ANALYZE');await f.approve();await f.run('GENERATE');await f.service.configure(f.task.id,{environmentId:'fixture',modelId:'execution',timeoutMs:10000,harnessTools:[]});
  f.caps.nativeCapabilities=[];const failed=await f.service.reviewRuntime(f.task.id);expect(failed.runtimeReview?.status).toBe('FAILED');await expect(f.service.checkRuntime(f.task.id)).rejects.toThrow('不满足');
  f.caps.nativeCapabilities=[readerCapability];await f.service.configure(f.task.id,{environmentId:'fixture',modelId:'execution',timeoutMs:11000,harnessTools:[]});expect((await f.service.get(f.task.id)).runtimeReviewCurrent).toBe(false);
});
it('blocks repair when passing cases only lack coverage, preserving the candidate',async()=>{
 const f=await setup();await f.run('ANALYZE');await f.approve();let task=await f.run('GENERATE');
 task=await f.service.configure(task.id,{environmentId:'fixture',modelId:'execution',timeoutMs:10000,harnessTools:[]});
 const originalCandidate=task.currentCandidateId;
 await f.repo.update(task.id,t=>{t.runs.push({id:'uncovered',candidateId:t.currentCandidateId!,candidateDigest:'a'.repeat(64),
   configuration:t.configuration!,configurationDigest:'b'.repeat(64),suite:{name:'Partial coverage',cases:[{id:'passing',input:'Read data',criteria:['Read correctly']}]},
   suiteDigest:'c'.repeat(64),phase:'development',status:'INCOMPLETE',createdAt:new Date().toISOString(),
   cases:[{id:'passing',passed:true,reason:'Actual result correct'}],requirementCoverage:[{id:'untested',status:'UNVERIFIED',caseIds:[]}]});});
 const before=f.agent.mock.calls.length;
 await expect(f.service.start(task.id,'REPAIR',{key:randomUUID(),baseCandidateId:originalCandidate,runId:'uncovered'})).rejects.toThrow('没有候选失败证据');
 expect(f.agent).toHaveBeenCalledTimes(before);expect((await f.service.get(task.id)).currentCandidateId).toBe(originalCandidate);
});
it.each(['member','evidence','tool-path','tool-evidence','dependency-tool'])('rejects fabricated %s references while retaining previous analysis',async fault=>{
  const f=await setup();const original=await f.run('ANALYZE');
  f.agent.mockImplementationOnce(async(input:any)=>{const result=await fixtureAgent(input);if(fault==='member')result.analysis.plan.changes[0].memberIds=['outside'];else if(fault==='evidence')result.analysis.plan.changes[0].evidence=[{path:'SKILL.md',snippet:'fabricated'}];else if(fault==='tool-path')result.analysis.diagnosis.tools[0].sourcePaths=['outside.py'];else if(fault==='tool-evidence')result.analysis.diagnosis.tools[0].evidence[0].snippet='fabricated';else result.analysis.diagnosis.dependencies[0].toolIds=['outside-tool'];return result;});
  const result=await f.run('ANALYZE');expect(result.attempts.at(-1)?.status).toBe('FAILED');expect(result.analysis).toEqual(original.analysis);expect(result.planRevisions).toHaveLength(1);
});
it('renders old change items separately without inventing before/after facts or splitting code and arguments',()=>{
  const reason='适配共享配置：移除 `from app import settings`，改为读取环境（A，B），保留错误语义；返回 `{"a":1,"b":2}` 不变。';
  const analysis={summary:'原说明',changes:[{paths:['tool.py'],reason}],missing:[]};
  const cards=legacyChangeCards(analysis);
  expect(cards).toEqual([{title:'适配共享配置',paths:['tool.py'],memberIds:[],original:reason,points:['移除 `from app import settings`，','改为读取环境（A，B），','保留错误语义；','返回 `{"a":1,"b":2}` 不变。']}]);
  expect(analysis.changes[0]?.reason).toBe(reason);
});
it('reads old analysis without inventing missing plan fields or changing its source text',()=>{
  const summary='原工程。业务契约已核实并全部保留：输入（a；b）保持不变；错误不变。改造方案：1) 改配置；2) 保留接口。待实施阶段运行时确认（非阻塞）：依赖版本待核验。';
  const old={summary,changes:[],missing:[]};expect(analysisSchema.parse(old)).toEqual(old);
  const sections=legacyPlanSections(old);expect(sections.preservedBehavior.join('')).toContain('输入（a；b）保持不变');expect(sections.conditions.join('')).toContain('依赖版本待核验');expect(sections.acceptance).toEqual([]);expect(old.summary).toBe(summary);
  expect(proseParagraphs('执行 `a;b`；完成。')).toEqual(['执行 `a;b`；','完成。']);
});
