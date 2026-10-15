import {expect,it,vi} from 'vitest';
import {unzipSync} from 'fflate';
import {MigrationToolOptimizationService} from '../src/migration/application/migration-tool-optimization-service.js';
import type {MigrationProject} from '../src/migration/domain/migration-project.js';
import type {MigrationProjectStore} from '../src/migration/application/migration-project-store.js';
import type {MigrationSkillRepository} from '../src/migration/application/migration-skill-repository.js';
import type {MigrationTechnicalValidationWorkflow} from '../src/migration/application/migration-technical-validation-service.js';
import type {MigrationEvaluationJobReader} from '../src/migration/application/migration-evaluation-ports.js';

function setup(passed:boolean){
  const base={assetId:'asset-1',artifactSha256:'a'.repeat(64),skillId:'balance',version:'1.0.0',skillFile:'SKILL.md'} as MigrationProject['source'];
  const output={...base,assetId:'asset-2',artifactSha256:'b'.repeat(64),version:'1.0.0-tool.test'};
  const project={id:'migration-1234',source:base,candidate:base,inspection:{tools:[{toolId:'balance-tool',name:'balance',kind:'SCRIPT'}]},
    portableGenerations:[{toolId:'balance-tool',readyForValidation:true,files:['scripts/balance.py','SKILL.md']}],
    improvementPlans:[{planId:'plan-1',sourceJobId:'job-1',candidateDigest:base.artifactSha256,developmentCaseIds:['dev'],status:'PROPOSED',
      hypothesis:{layer:'TOOL',issue:'解析错误',toolIds:['balance-tool']}}],runs:[{jobId:'job-1',suiteSnapshot:{cases:[{caseId:'dev',prompt:'开发题'}],holdoutCases:[{caseId:'secret',prompt:'HOLDOUT_SECRET'}]}}],
    technicalValidations:[],candidateHistory:[]} as unknown as MigrationProject;
  const projects={get:async()=>project,save:async()=>undefined,runExclusive:async(_id:string,action:()=>Promise<unknown>)=>action()} as MigrationProjectStore;
  const archive={'SKILL.md':new TextEncoder().encode('---\nname: balance\nversion: 1.0.0\n---\nTool skill'),
    'scripts/balance.py':new TextEncoder().encode('print(1)')};
  const upload=vi.fn(async(buffer:Buffer)=>{
    const files=unzipSync(buffer);
    expect(new TextDecoder().decode(files['scripts/balance.py'])).toBe('print(2)');
    expect(new TextDecoder().decode(files['SKILL.md'])).toContain('version: 1.0.0-tool.');
    return output;
  });
  const skills={readArchive:async()=>archive,uploadZip:upload,get:async()=>output} as unknown as MigrationSkillRepository;
  const technical={validateIsolated:vi.fn(async()=>({validationId:'validation-1',toolId:'balance-tool',assetId:output.assetId,
    assetDigest:output.artifactSha256,status:passed?'PASSED':'FAILED'})),
    currentState:vi.fn(async(value:MigrationProject)=>({ready:value.technicalValidations?.every(result=>result.status==='PASSED')??false,reasons:[]}))} as unknown as MigrationTechnicalValidationWorkflow;
  const jobs={get:()=>({report:{cases:[{caseId:'dev',prompt:'开发题',right:{status:'completed',toolCalls:[{name:'balance',status:'failed'}]},judge:{summary:'工具失败'}},
    {caseId:'secret',prompt:'HOLDOUT_SECRET',right:{status:'completed',toolCalls:[]},judge:{summary:'HOLDOUT_SECRET'}}]}})} as MigrationEvaluationJobReader;
  return {project,skills,technical,service:new MigrationToolOptimizationService(projects,skills,technical,async input=>{
    expect(JSON.stringify(input)).not.toContain('HOLDOUT_SECRET');
    return {toolId:'balance-tool',summary:'修复解析',changes:[{path:'scripts/balance.py',content:'print(2)',reason:'修复返回值'}]};
  },jobs),jobs};
}

it('keeps failed Tool experiments isolated from the active candidate',async()=>{
  const {service,project}=setup(false);
  const attempt=await service.propose(project.id,{planId:'plan-1'});
  expect(attempt.status).toBe('TECHNICAL_FAILED');
  expect(project.candidate?.assetId).toBe('asset-1');
  expect(project.technicalValidations).toEqual([]);
  await expect(service.adopt(project.id,{attemptId:attempt.attemptId})).rejects.toThrow('技术验证全部通过');
});

it('adopts only a technically passed Tool candidate and requires a new effect run',async()=>{
  const {service,project}=setup(true);
  const attempt=await service.propose(project.id,{planId:'plan-1'});
  expect(attempt.status).toBe('TECHNICAL_PASSED');
  expect(project.candidate?.assetId).toBe('asset-1');
  await service.adopt(project.id,{attemptId:attempt.attemptId});
  expect(project.candidate?.assetId).toBe('asset-2');
  expect(project.technicalValidations).toHaveLength(1);
  expect(project.runs).toHaveLength(1);
  expect(project.runs[0]?.candidateDigest).toBeUndefined();
});

it('rejects Tool proposals that edit the Skill document',async()=>{
  const {project,skills,technical,jobs}=setup(true);
  const projects={get:async()=>project,save:async()=>undefined,runExclusive:async(_id:string,action:()=>Promise<unknown>)=>action()} as MigrationProjectStore;
  const service=new MigrationToolOptimizationService(projects,skills,technical,async()=>({toolId:'balance-tool',summary:'x',
    changes:[{path:'SKILL.md',content:'new',reason:'bypass'}]}),jobs);
  await expect(service.propose(project.id,{planId:'plan-1'})).rejects.toThrow('只能修改');
});
