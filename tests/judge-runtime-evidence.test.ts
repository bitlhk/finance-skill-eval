import {expect,it} from 'vitest';
import {runtimeExecutionEvidenceSchema} from '../src/contracts.js';
import {judgeRuntimeEvidence} from '../src/judge-runtime-evidence.js';
import {workspaceFilesDigest} from '../src/contracts.js';
import {canonicalSha256} from '../src/shared/json-canonicalization.js';

it('preserves native execution proof without workspace contents, paths or source digests',()=>{
  const evidence=runtimeExecutionEvidenceSchema.parse({runId:'r',caseId:'c',side:'right',status:'completed',modelId:'m',skillVersion:null,output:'answer',elapsedMs:1,runtimeIdentityVerified:true,streamCompleted:true,error:null,
    toolCalls:[{name:'read_file',status:'completed'},{name:'read_file',status:'failed'},{name:'list_files',status:'completed'},{name:'balance',status:'completed'}],
    metadata:{toolEvidence:[{tool:'read_file',result:'PRIVATE_CONTENT',path:'PRIVATE_PATH',resultDigest:'PRIVATE_DIGEST'},{tool:'list_files',result:['PRIVATE_FILENAME']},{tool:'balance',result:{amount:'10.00'}},null,42]}});
  const result=judgeRuntimeEvidence(evidence);
  expect(result.runtimeSupportToolCalls).toEqual([{name:'read_file',status:'completed'},{name:'read_file',status:'failed'},{name:'list_files',status:'completed'}]);
  expect(result.toolCalls).toEqual([{name:'balance',status:'completed'}]);
  expect(result.sourceFacts).toEqual([{tool:'balance',result:{amount:'10.00'}}]);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
});

it.each(['match','different-mount','different-read','different-arguments','failed-read','no-schema'] as const)('matches actual input hashes without disclosing values: %s',change=>{
 const file={path:'input.json',content:JSON.stringify({selection:'PRIVATE_SELECTION',price:'2.51',quantity:5})};
 const facts=[{tool:'read_file',status:change==='failed-read'?'failed':'completed',argumentsDigest:canonicalSha256({path:file.path}),resultDigest:change==='different-read'?'wrong':canonicalSha256({path:file.path,content:file.content})},
  {tool:'calculate',status:'completed',argumentsDigest:canonicalSha256({price:change==='different-arguments'?'4.25':'2.51',quantity:5})}];
 const evidence={status:'completed',streamCompleted:true,toolCalls:[{name:'read_file',status:change==='failed-read'?'failed':'completed'},{name:'calculate',status:'completed'}],metadata:{workspaceFilesMounted:true,workspaceFilesDigest:change==='different-mount'?'wrong':workspaceFilesDigest([file]),toolEvidence:facts}};
 const result=judgeRuntimeEvidence(evidence as never,{workspaceFiles:[file],tools:change==='no-schema'?[]:[{name:'calculate',inputSchema:{type:'object',properties:{price:{type:'string'},quantity:{type:'integer'}}}}]});
 const expected=change==='match'?['FILE_READ','TOOL_ARGUMENT_VALUES']:['different-arguments','no-schema'].includes(change)?['FILE_READ']:[];
 expect(result.workspaceInputMatches.map(m=>m.kind)).toEqual(expected);
 expect(JSON.stringify(result)).not.toContain('PRIVATE_SELECTION');expect(JSON.stringify(result)).not.toContain('2.51');
});
it('retains per-turn receipts without exposing host session/workspace identifiers',()=>{
 const result=judgeRuntimeEvidence({status:'completed',streamCompleted:true,toolCalls:[],metadata:{conversation:{sessionId:'PRIVATE_SESSION',workspaceId:'PRIVATE_PATH',turns:[{index:0,status:'completed',queryDigest:'query-sha',outputDigest:'output-sha',output:'wait',toolNames:['read_file']},{index:1,status:'completed',queryDigest:'next-sha',outputDigest:'answer-sha',output:'40.11',toolNames:['calculate_total']}]}}} as never);
 expect(result.conversation?.turns[1]).toMatchObject({index:1,toolNames:['calculate_total']});expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

it.each(['match','unverified','different-artifact','different-content','workspace-scope','failed-read','unsafe-path'] as const)('proves Skill-package reads only from exact bound actual receipts: %s',change=>{
 const path=change==='unsafe-path'?'../private.txt':'references/policy.md',content='PRIVATE_POLICY_CONTENT';
 const artifact='a'.repeat(64);
 const evidence={status:'completed',streamCompleted:true,runtimeIdentityVerified:change!=='unverified',
  toolCalls:[{name:'read_file',status:change==='failed-read'?'failed':'completed'}],metadata:{skillArtifactSha256:change==='different-artifact'?'b'.repeat(64):artifact,
  toolEvidence:[{tool:'read_file',status:change==='failed-read'?'failed':'completed',
   argumentsDigest:canonicalSha256({path,scope:change==='workspace-scope'?'workspace':'skill'}),
   resultDigest:canonicalSha256({path,content:change==='different-content'?'different':content})}]}};
 const result=judgeRuntimeEvidence(evidence as never,{skillPackage:{artifactSha256:artifact,files:{[path]:content}}});
 expect(result.skillFileReads).toEqual(change==='match'?[{tool:'read_file',path,scope:'skill',kind:'FILE_READ'}]:[]);
 expect(JSON.stringify(result)).not.toContain(content);
 expect(result.workspaceInputMatches).toEqual([]);
});
