import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { MigrationTaskService } from '../src/migration/tasks/application/task-service.js';
import { FileMigrationTaskRepository } from '../src/migration/tasks/infrastructure/task-repository.js';
import { bundleZip, filesDigest, snapshot } from '../src/migration/tasks/domain/task-model.js';
import type { BundleAgent, BundleAgentInput, BundleRuntimeFactory, BundleJudge } from '../src/migration/tasks/application/task-ports.js';
import { loadAgentRole } from '../src/agents/composition.js';

const roots: string[] = [], services: MigrationTaskService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true, force:true})));
});
const encode = (text:string) => Buffer.from(text).toString('base64');
const files = {'app/main.py':encode('load("resources/deep/SKILL.md")'),
  'resources/deep/SKILL.md':encode('Legacy instructions without frontmatter')};
const report = {summary:'Identified original loader',skills:[{path:'resources/deep/SKILL.md',usage:'app/main.py loads it'}],
  entrypoints:['python app/main.py'],missing:['Business cases'],baselinePlan:'Run frozen business cases against original behavior'};
async function fixture(agent:BundleAgent, runtime?:BundleRuntimeFactory, judge?:BundleJudge, improvements?:()=>import('../src/improvement/application/improvement-agents.js').ImprovementAgents) {
  const root = await mkdtemp(path.join(os.tmpdir(),'project-preparation-')); roots.push(root);
  const repository = new FileMigrationTaskRepository(root);
  const service = new MigrationTaskService(repository,
    {get:async()=>{throw Error('unused');},readArchive:async()=>{throw Error('unused');}},agent,
    runtime ?? (async()=>{throw Error('Business runtime must not be invoked during preparation');}),judge ?? (async()=>{throw Error('unused');}),undefined,undefined,undefined,improvements);
  services.push(service); await service.initialize();
  return {service,repository};
}
async function finish(service:MigrationTaskService,id:string,kind:'PREPARE'|'ANALYZE'|'BASELINE',clarification?:string) {
  await service.start(id,kind,{key:randomUUID(),baseCandidateId:null,...(clarification?{clarification}:{})});
  await vi.waitFor(async()=>expect((await service.get(id)).attempts.at(-1)?.status).not.toBe('RUNNING'));
  return service.get(id);
}
it('keeps strict Skill uploads but accepts complete projects, including deep legacy and absent Skill files',async()=>{
  const {service}=await fixture(async()=>({status:'ABSTAINED'}));
  await expect(service.upload({},bundleZip(files))).rejects.toThrow();
  const imported=await service.upload({inputKind:'agent_project',projectNotes:'Use app/main.py'},bundleZip(files));
  expect(imported.source.members).toEqual([]);
  expect(imported.projectNotes).toBe('Use app/main.py');
  expect((await service.readSnapshot(imported.id,null)).files).toEqual(files);
  await expect(service.upload({inputKind:'agent_project'},bundleZip({'main.py':encode('print(1)')}))).resolves.toBeDefined();
  expect(snapshot({'a/b/c/SKILL.md':encode('---\nname: deep\ndescription: example\n---\nTask')},'source').members).toHaveLength(1);
});
it('preserves source, continues from preparation, and never promotes command success to a business baseline',async()=>{
  const seen:BundleAgentInput[]=[];
  const prepared={...files,'adapter.txt':encode('minimal preparation')};
  const {service}=await fixture(async input=>{
    seen.push(input);
    return input.mode==='ANALYZE'?{status:'PRODUCED',analysis:{summary:'Inspect prepared engineering',changes:[],missing:[]}}:
      {status:'PRODUCED',files:prepared,preparation:report,executions:[{command:['python','app/main.py'],cwd:'.',
        status:'COMPLETED',exitCode:0,output:'ok',snapshotDigest:filesDigest(input.base.files)}]};
  });
  const task=await service.upload({inputKind:'agent_project',projectNotes:'Original startup'},bundleZip(files));
  const first=await finish(service,task.id,'PREPARE');
  expect(first.attempts.at(-1)?.status).toBe('COMPLETED');
  expect(first.preparations?.[0]?.baselineStatus).toBe('NOT_EVALUATED');
  expect(first.currentCandidateId).toBeNull();expect(first.runs).toEqual([]);
  expect((await service.readSnapshot(task.id,null)).files).toEqual(files);
  await finish(service,task.id,'PREPARE','Additional context');
  expect(seen[1]?.base.files).toEqual(prepared);
  expect(seen[1]?.clarification).toBe('Additional context');
  expect(seen[1]?.project?.notes).toBe('Original startup');
  await finish(service,task.id,'ANALYZE');
  expect(seen[2]?.base.files).toEqual(prepared);
  expect(seen[2]?.project?.preparation).toEqual(report);
  const again=await finish(service,task.id,'PREPARE');
  expect(again.analysis).toBeUndefined();
});
it('rejects invented Skill files without publishing a preparation',async()=>{
  const {service}=await fixture(async()=>({status:'PRODUCED',files,preparation:{...report,skills:[{path:'invented.md',usage:'unknown'}]}}));
  const task=await service.upload({inputKind:'agent_project'},bundleZip(files));
  const result=await finish(service,task.id,'PREPARE');
  expect(result.attempts.at(-1)?.status).toBe('FAILED');
  expect(result.preparations).toBeUndefined();
});
it('assembles concise preparation guidance on the existing engineering executor',()=>{
  const role=loadAgentRole('runtime-preparation');
  expect(role.definition.executor).toBe('openjiuwen-bundle');
  expect(role.definition.tools).toContain('run_project_command');
  expect(role.definition.tools).not.toContain('compile_source');
  expect(role.definition.skills).toEqual(['skills/runtime-preparation/SKILL.md']);
});

it.each(['passed','business-failure','missing-evidence','runtime-error','judge-error'] as const)('evaluates the frozen project via the shared runtime and judge: %s',async scenario=>{
  const cleanup=vi.fn(async()=>{}), judge=vi.fn(async()=>{
    if(scenario==='judge-error')throw Error('Judge offline');
    return {passed:scenario!=='business-failure',reason:'Business rubric'};
  });
  const runtime:BundleRuntimeFactory=async input=>{
    expect(input.executionMode).toBe('agent_project');
    expect(input.snapshot.files).toEqual(files);
    if(scenario==='runtime-error')throw Error('Project execution unsupported');
    return {model:{providerId:'test',modelId:'original',parameters:{}},environmentSnapshot:{id:'original'},runtime:{
      adapterId:'original',cleanup,prepare:async()=>{},finalizationEvidence:()=>({status:'RELEASED'}),
      execute:async request=>({runId:request.runId,caseId:request.evalCase.caseId,side:request.side,
        status:'completed',modelId:'original',skillVersion:'original',output:'Actual business result',elapsedMs:1,
        toolCalls:[],loadedSkills:[],usage:null,runtimeIdentityVerified:true,streamCompleted:true,error:null,
        metadata:{contentDigest:input.snapshot.digest,...(scenario==='missing-evidence'?{}:{projectExecution:true})}}),
    }};
  };
  const diagnose=vi.fn(async()=>({judgement:{status:'ABSTAINED',reason:'Insufficient causal evidence'},investigation:[]} as any));
  const {service}=await fixture(async()=>({status:'PRODUCED',files,preparation:report}),runtime,judge,()=>({diagnose,review:vi.fn()}));
  const task=await service.upload({inputKind:'agent_project'},bundleZip(files));
  await finish(service,task.id,'PREPARE');
  await service.configure(task.id,{environmentId:'original',modelId:'original',harnessTools:[]},'baseline');
  await service.saveSuite(task.id,{name:'Business baseline',cases:[{id:'case',input:'Review budget',criteria:['Correct result']}]});
  const result=await finish(service,task.id,'BASELINE'),run=result.runs[0]!;
  expect(run.purpose).toBe('baseline');
  expect(run.status).toBe(scenario==='passed'?'PASSED':scenario==='business-failure'?'FAILED':'INCOMPLETE');
  expect(run.candidateId).toBe(result.preparations![0]!.id);
  expect(result.currentCandidateId).toBeNull();expect(result.verifiedRunId).toBeUndefined();
  expect(result.currentBaselineRunId).toBe(['passed','business-failure'].includes(scenario)?run.id:undefined);
  expect(judge).toHaveBeenCalledTimes(['missing-evidence','runtime-error'].includes(scenario)?0:1);
  expect(cleanup).toHaveBeenCalledTimes(scenario==='runtime-error'?0:1);
  const analyzed=await service.analyzeRun(task.id,{runId:run.id});
  expect(analyzed.runAnalyses).toHaveLength(1);
  expect(analyzed.runAnalyses![0]!.sourceRunId).toBe(run.id);
  expect(analyzed.runs).toEqual(result.runs);
  expect(analyzed.currentCandidateId).toBeNull();
  expect(diagnose).toHaveBeenCalledTimes(1);
  expect(cleanup).toHaveBeenCalledTimes(scenario==='runtime-error'?0:1);
  expect(diagnose.mock.calls[0]?.[0]?.codeEvidence).toBeDefined();
  if(scenario!=='runtime-error')expect(run.cases[0]?.evidence?.output).toBe('Actual business result');
  if(scenario!=='runtime-error'){
    expect(run.cases[0]?.methodResults?.map(method=>method.status)).toEqual([
      scenario==='missing-evidence'?'UNVERIFIED':'PASS',
      scenario==='missing-evidence'?'SKIP':scenario==='judge-error'?'ERROR':scenario==='business-failure'?'FAIL':'PASS',
    ]);
    if(scenario==='judge-error')expect(run.cases[0]?.failureStage).toBe('JUDGE');
  }
  await service.configure(task.id,{environmentId:'changed',modelId:'original',harnessTools:[]},'baseline');
  expect((await service.get(task.id)).currentBaselineRunId).toBeUndefined();
  expect((await service.get(task.id)).runs).toHaveLength(1);
});
