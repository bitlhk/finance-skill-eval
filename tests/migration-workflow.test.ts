import { describe, expect, it } from 'vitest';
import { migrationWorkflow } from '../src/migration/domain/migration-workflow.js';
import type { MigrationProject } from '../src/migration/domain/migration-project.js';
import { inspectionFixture } from './analysis-fixture.js';

const asset={schemaVersion:'finance.skill-eval.skill-asset.v1',assetId:'asset',skillId:'workflow',version:'1.0.0',displayName:'Workflow',description:'test',sourceType:'uploaded',artifactSha256:'a'.repeat(64),skillFile:'SKILL.md',fileCount:1,createdAt:'now'} as const;
const project=(overrides:Partial<MigrationProject>={}):MigrationProject=>({schemaVersion:'finance.skill-migration.v2',id:'migration-00000000-0000-0000-0000-000000000000',name:'workflow',createdAt:'now',source:asset,candidate:null,candidateNotes:'',runs:[],assessment:'NOT_VALIDATED',...overrides});
const plan=(generationAllowed:boolean)=>({baseAssetId:'asset',generationAllowed,skillMigrationItems:[],skillBlockingReasons:generationAllowed?[]:['blocked'],items:[]});

describe('migration workflow',()=>{
  it('requires implementation under the revised proposal despite old technical and business passes',()=>{
    const p=project({candidate:asset,inspection:inspectionFixture([]),candidateReuseProposalId:'old'});
    const result=migrationWorkflow(p,{migrationPlan:{...plan(true),reuseProposal:{proposalId:'new',approvedAt:'now'} as any},runtimeRequirementsPending:false,technicalReady:true,evaluationCompleted:true});
    expect(result).toMatchObject({stage:'GENERATE',furthestStage:2,blockers:['迁移方案已更新，请按本版方案生成并审查候选']});
    expect(result.allowedActions).not.toContain('EVALUATE');expect(result.allowedActions).not.toContain('EXPORT');
  });
  it('derives diagnosis and generation from persisted inspection evidence',()=>{
    expect(migrationWorkflow(project(),{migrationPlan:null,runtimeRequirementsPending:false,technicalReady:false,evaluationCompleted:false}).stage).toBe('DIAGNOSE');
    const inspected=project({inspection:inspectionFixture([])});
    expect(migrationWorkflow(inspected,{migrationPlan:plan(false),runtimeRequirementsPending:false,technicalReady:false,evaluationCompleted:false})).toMatchObject({stage:'DIAGNOSE',furthestStage:1});
    expect(migrationWorkflow(inspected,{migrationPlan:plan(true),runtimeRequirementsPending:false,technicalReady:false,evaluationCompleted:false})).toMatchObject({stage:'GENERATE',furthestStage:2});
  });

  it('does not allow validation past an unresolved Runtime capability requirement',()=>{
    const generated=project({inspection:inspectionFixture([]),candidate:{...asset,assetId:'candidate',version:'2.0.0',artifactSha256:'b'.repeat(64)},portableGenerations:[]});
    expect(migrationWorkflow(generated,{migrationPlan:plan(true),runtimeRequirementsPending:true,technicalReady:false,evaluationCompleted:false})).toMatchObject({stage:'ADAPT_RUNTIME',furthestStage:3,allowedActions:expect.not.arrayContaining(['VALIDATE_TECHNICAL'])});
  });

  it('advances only from current technical and evaluation evidence',()=>{
    const generated=project({inspection:inspectionFixture([]),candidate:{...asset,assetId:'candidate',version:'2.0.0',artifactSha256:'b'.repeat(64)},portableGenerations:[]});
    expect(migrationWorkflow(generated,{migrationPlan:plan(true),runtimeRequirementsPending:false,technicalReady:false,evaluationCompleted:false}).furthestStage).toBe(4);
    expect(migrationWorkflow(generated,{migrationPlan:plan(true),runtimeRequirementsPending:false,technicalReady:true,evaluationCompleted:false}).furthestStage).toBe(5);
    expect(migrationWorkflow(generated,{migrationPlan:plan(true),runtimeRequirementsPending:false,technicalReady:true,evaluationCompleted:true})).toMatchObject({stage:'EXPORT',furthestStage:6});
  });
});
