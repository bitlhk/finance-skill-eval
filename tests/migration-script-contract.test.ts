import {expect,it} from 'vitest';
import {migrationScriptInputSchema} from '../src/migration/domain/migration-script-contract.js';
import {toolFixture,inspectionFixture} from './analysis-fixture.js';
import type {MigrationProject} from '../src/migration/domain/migration-project.js';

const schema={type:'object',properties:{subtotal:{type:'string'},tax_rate:{type:'string'}},required:['subtotal','tax_rate']};
function fixture(){
 const tool=toolFixture({name:'calculate',sourcePaths:['scripts/calculate.py'],kind:'SCRIPT',inputSchema:null,entrypoint:{kind:'PYTHON',path:'scripts/calculate.py'}});
 const project={source:{artifactSha256:'source'},candidate:{artifactSha256:'candidate'},
  sourceInspection:inspectionFixture([{...tool,inputSchema:schema}]),
  inspection:{...inspectionFixture([tool]),assetDigest:'candidate',reuseConformance:{proposalId:'proposal',candidateDigest:'candidate',
   review:{changes:[{changeId:'portable',status:'CONFORMING'}],unexpectedDependencies:[],semanticIssues:[]}}},
  reuseProposal:{proposalId:'proposal',sourceDigest:'source',approvedAt:'now',design:{changes:[{id:'portable'}]}},
  portableGenerations:[{toolId:tool.toolId,toolName:'calculate',form:'SCRIPT',entrypoint:'scripts/calculate.py'}]} as unknown as MigrationProject;
 return {project,tool};
}
it('preserves the reviewed source interface if candidate analysis omits it, without mutating either inspection',()=>{
 const {project,tool}=fixture();const result=migrationScriptInputSchema(project,tool);
 expect(result).toEqual(schema);expect(result).not.toBe(schema);expect(tool.inputSchema).toBeNull();
 expect(project.sourceInspection!.tools[0]!.inputSchema).toEqual(schema);
});
it('never replaces an explicitly analyzed candidate interface',()=>{
 const {project,tool}=fixture();tool.inputSchema={type:'object',properties:{value:{type:'number'}}};
 expect(migrationScriptInputSchema(project,tool)).toBe(tool.inputSchema);
});
it.each(['unapproved','wrong-proposal','wrong-candidate','negative-review','incomplete-review','semantic-change'])('rejects unverified preservation: %s',kind=>{
 const {project,tool}=fixture();
 if(kind==='unapproved')delete project.reuseProposal!.approvedAt;
 if(kind==='wrong-proposal')project.inspection!.reuseConformance!.proposalId='other';
 if(kind==='wrong-candidate')project.inspection!.reuseConformance!.candidateDigest='other';
 if(kind==='negative-review')project.inspection!.reuseConformance!.review.changes[0]!.status='NEEDS_CHANGES';
 if(kind==='incomplete-review')project.inspection!.reuseConformance!.review.changes=[];
 if(kind==='semantic-change')project.inspection!.reuseConformance!.review.semanticIssues=['Changed calculation'];
 expect(()=>migrationScriptInputSchema(project,tool)).toThrow('输入合同');
});
it.each(['no-generation','wrong-id','wrong-path','mcp','unknown-source'])('does not invent a contract without an exact source/generation mapping: %s',kind=>{
 const {project,tool}=fixture();
 if(kind==='no-generation')project.portableGenerations=[];
 if(kind==='wrong-id')project.portableGenerations![0]!.toolId='other';
 if(kind==='wrong-path')project.portableGenerations![0]!.entrypoint='other.py';
 if(kind==='mcp')project.portableGenerations![0]!.form='MCP';
 if(kind==='unknown-source')project.sourceInspection!.tools[0]!.inputSchema=null;
 expect(migrationScriptInputSchema(project,tool)).toBeUndefined();
});
