import {expect,it,vi} from 'vitest';
import {MigrationCandidateService} from '../src/migration/application/migration-candidate-service.js';
import type {MigrationProject} from '../src/migration/domain/migration-project.js';
import type {MigrationProjectStore} from '../src/migration/application/migration-project-store.js';
import type {MigrationSkillRepository} from '../src/migration/application/migration-skill-repository.js';
import {currentReuseProposal,reuseInputDigest} from '../src/migration/domain/migration-reuse-design.js';
import {inspectionFixture,toolFixture} from './analysis-fixture.js';

function fixture(){
 const source={assetId:'source',skillId:'balance',version:'1',artifactSha256:'a'.repeat(64),skillFile:'SKILL.md'} as MigrationProject['source'];
 const base={...source,assetId:'old',version:'2',artifactSha256:'b'.repeat(64)},candidate={...source,assetId:'new',version:'3',artifactSha256:'c'.repeat(64)};
 const sourceInspection={...inspectionFixture([toolFixture({name:'balance',sourcePaths:['mcp/server.py']})],source.assetId),assetDigest:source.artifactSha256};
 const inspection={...sourceInspection,assetId:base.assetId,assetDigest:base.artifactSha256};
 const decisions=inspection.tools.map(tool=>({toolId:tool.toolId,form:'MCP' as const,language:'python',baseAssetId:base.assetId}));
 const project={id:'migration-fixture',source,candidate:base,inspection,sourceInspection,decisions,runs:[],
  reuseProposal:{proposalId:'approved',approvedAt:'now',sourceDigest:source.artifactSha256,inputDigest:reuseInputDigest(sourceInspection,decisions.map(item=>({...item,baseAssetId:source.assetId})),source.artifactSha256)},
  candidateReuseProposalId:'approved',portableGenerations:[{toolId:inspection.tools[0]!.toolId,files:['mcp/server.py'],entrypoint:'mcp/server.py',
   start:['uv','run','mcp/server.py'],prepare:['uv','sync'],readyForValidation:true,callExecuted:true,checks:[{name:'old check',passed:true}]}],
  technicalValidations:[{assetDigest:base.artifactSha256,status:'PASSED'}],analysis:{assetDigest:base.artifactSha256},portableGenerationDiff:[{path:'old'}]} as unknown as MigrationProject;
 const save=vi.fn();const projects={get:async()=>project,save,runExclusive:async(_id:string,action:()=>Promise<unknown>)=>action()} as unknown as MigrationProjectStore;
 const files={'SKILL.md':new Uint8Array(),'mcp/server.py':new Uint8Array()};
 const skills={get:async()=>candidate,readArchive:async()=>files} as unknown as MigrationSkillRepository;
 const inspectRevision=vi.fn(async()=>({...inspection,assetId:candidate.assetId,assetDigest:candidate.artifactSha256,reuseConformance:{proposalId:'approved',candidateDigest:candidate.artifactSha256}}));
 const service=new MigrationCandidateService(projects,skills,undefined,{inspectRevision} as any);
 return {project,candidate,files,save,inspectRevision,service};
}
it('reviews manual repairs against the frozen plan, retaining declarations but not old execution claims',async()=>{
 const f=fixture(),source=structuredClone(f.project.source),oldResults=structuredClone(f.project.technicalValidations);
 await f.service.import(f.project.id,{assetId:'new',notes:'Fix API spelling'});
 expect(f.inspectRevision).toHaveBeenCalledOnce();expect(f.save).toHaveBeenCalledOnce();
 expect(f.project.source).toEqual(source);expect(f.project.candidate).toEqual(f.candidate);
 expect(currentReuseProposal(f.project)?.proposalId).toBe('approved');expect(f.project.candidateReuseProposalId).toBe('approved');
 expect(f.project.inspection).toMatchObject({assetDigest:f.candidate.artifactSha256,reuseConformance:{proposalId:'approved'}});
 expect(f.project.decisions?.every(item=>item.baseAssetId==='new')).toBe(true);
 expect(f.project.portableGenerations?.[0]).toMatchObject({start:['uv','run','mcp/server.py'],prepare:['uv','sync'],callExecuted:false});
 expect(f.project.portableGenerations?.[0]).not.toHaveProperty('checks');expect(f.project).not.toHaveProperty('analysis');
 expect(f.project).not.toHaveProperty('portableGenerationDiff');expect(f.project.technicalValidations).toEqual(oldResults);
});
it('does not change the active candidate when independent review fails',async()=>{
 const f=fixture(),original=structuredClone(f.project);f.inspectRevision.mockRejectedValueOnce(new Error('TOOLS_MISMATCH'));
 await expect(f.service.import(f.project.id,{assetId:'new',notes:'repair'})).rejects.toThrow('TOOLS_MISMATCH');
 expect(f.project).toEqual(original);expect(f.save).not.toHaveBeenCalled();
});
it.each(['identity','version','digest','missing file','stale plan','running'])('rejects %s before candidate review',async kind=>{
 const f=fixture();
 if(kind==='identity')f.candidate.skillId='another';
 if(kind==='version')f.candidate.version='2';
 if(kind==='digest')f.candidate.artifactSha256=f.project.candidate!.artifactSha256;
 if(kind==='missing file')delete (f.files as Record<string,Uint8Array>)['mcp/server.py'];
 if(kind==='stale plan')f.project.reuseProposal!.inputDigest='stale';
 if(kind==='running')f.project.reuseAcceptanceResults=[{status:'RUNNING'} as any];
 const original=structuredClone(f.project);
 await expect(f.service.import(f.project.id,{assetId:'new',notes:'repair'})).rejects.toThrow();
 expect(f.inspectRevision).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();expect(f.project).toEqual(original);
});
