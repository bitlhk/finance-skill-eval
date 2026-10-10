import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {ModelGoalJudge} from '../src/goal-judge.js';
import {ModelCandidateJudge,ModelPairwiseJudge} from '../src/judge.js';
import {loadEvalPack} from '../src/eval-pack.js';
import {evalCaseSchema, runtimeExecutionEvidenceSchema, workspaceFilesDigest} from '../src/contracts.js';

const content = '合成标记_NOT_A_BANK_FACT';
const files = [{path: 'case.txt', content}, {path: 'unread.txt', content: 'PRIVATE_UNREAD_CONTENT'}];
const digest = workspaceFilesDigest(files);
const checksum = createHash('sha256').update(content).digest('hex');
const definition = evalCaseSchema.parse({caseId:'file-case', name:'file-case', prompt:'Read the case file',
  evaluationGoal:'Verify file reading', workspaceFiles:files,
  rubric:[{criterionId:'file',label:'file',description:'Use the actual file',dimension:'business_completeness',weight:1}]});
function fixture() {
  return runtimeExecutionEvidenceSchema.parse({runId:'run-1', side:'right', caseId:definition.caseId,
    status:'completed', modelId:'test',skillVersion:'1', output:`File: ${content}`, elapsedMs:1,
    runtimeIdentityVerified:true, streamCompleted:true,error:null,
    toolCalls:[{name:'read_case_file',status:'completed'}],
    metadata:{executionMode:'runtime-launcher', workspaceFilesDigest:digest,
      caseWorkspace:{schemaVersion:'finance.case-workspace.v1',digest,closed:true,
        reads:[{path:'case.txt',bytes:Buffer.byteLength(content),sha256:checksum}]}}});
}
async function capture(right=fixture(), evalCase=definition) {
  const requests:any[]=[];
  const judge=new ModelGoalJudge({adapterId:'controlled',complete:async request=>{
    requests.push(request);
    return {modelId:'test',content:JSON.stringify({checks:[{criterionIndex:0,verdict:'INDETERMINATE',reason:'Only evidence plumbing tested',evidence:''}]})};
  }},{providerId:'test',modelId:'test',parameters:{}});
  const result=await judge.compare({evalCase,left:{...right,side:'left'},right,profile:{} as any});
  return {result, payload:JSON.parse(requests[0].messages[1].content),raw:JSON.stringify(requests)};
}
it('projects verified read receipts and answer offsets, never hidden file bodies or a quality verdict',async()=>{
  const {payload,raw,result}=await capture();
  expect(payload.runtimeEvidence.caseFiles).toMatchObject({status:'VERIFIED_READS',workspaceClosed:true,
    files:[{path:'case.txt',status:'READ_VERIFIED',bytes:Buffer.byteLength(content),sha256:checksum,readCount:1,
      exactTextInAnswer:{start:6,end:6+content.length,unit:'UTF16_CODE_UNIT'}},
      {path:'unread.txt',status:'READ_NOT_RECORDED'}]});
  expect(raw).not.toContain('PRIVATE_UNREAD_CONTENT');
  expect(JSON.stringify(payload.runtimeEvidence.caseFiles)).not.toContain(content);
  expect(result.goalAssessment?.verdict).toBe('INDETERMINATE');
});
it('does not send read file contents absent from the answer to the judge',async()=>{
  const right=fixture();right.output='I read a file.';
  const {payload,raw}=await capture(right);
  expect(payload.runtimeEvidence.caseFiles.files[0].exactTextInAnswer).toBeNull();
  expect(raw).not.toContain(content);
  expect(raw).not.toContain('PRIVATE_UNREAD_CONTENT');
});

it('distinguishes optional missing read receipts from malformed and conflicting receipts',async()=>{
 const absent=fixture();delete absent.metadata.caseWorkspace;
 expect((await capture(absent)).payload.runtimeEvidence.caseFiles).toEqual({status:'NOT_VERIFIED',reason:'WORKSPACE_READ_RECEIPT_NOT_PROVIDED'});
 const malformed=fixture();malformed.metadata.caseWorkspace={closed:true};
 expect((await capture(malformed)).payload.runtimeEvidence.caseFiles).toEqual({status:'NOT_VERIFIED',reason:'INVALID_WORKSPACE_READ_RECEIPT'});
 const conflict=fixture();conflict.metadata.workspaceFilesDigest='0'.repeat(64);
 expect((await capture(conflict)).payload.runtimeEvidence.caseFiles).toEqual({status:'NOT_VERIFIED',reason:'WORKSPACE_RECEIPT_MISMATCH'});
});
describe('does not promote unbound or inconsistent receipts',()=>{
  const mutations:Record<string,(e:ReturnType<typeof fixture>)=>void>={
    'wrong case':e=>{e.caseId='other-case';},
    'unverified identity':e=>{e.runtimeIdentityVerified=false;},
    'other execution mode':e=>{e.metadata.executionMode='http';},
    'wrong workspace':e=>{e.metadata.workspaceFilesDigest='0'.repeat(64);},
    'wrong receipt workspace':e=>{(e.metadata.caseWorkspace as any).digest='0'.repeat(64);},
    'open workspace':e=>{(e.metadata.caseWorkspace as any).closed=false;},
    'wrong bytes':e=>{(e.metadata.caseWorkspace as any).reads[0].bytes++;},
    'wrong hash':e=>{(e.metadata.caseWorkspace as any).reads[0].sha256='0'.repeat(64);},
    'unknown path':e=>{(e.metadata.caseWorkspace as any).reads[0].path='../secret';},
    'malformed receipt':e=>{(e.metadata.caseWorkspace as any).reads=[null];},
    'missing successful tool':e=>{e.toolCalls=[{name:'read_case_file',status:'failed'}];},
    'oversized receipts':e=>{(e.metadata.caseWorkspace as any).reads=Array(129).fill((e.metadata.caseWorkspace as any).reads[0]);},
  };
  for(const [name,mutate] of Object.entries(mutations))it(name,async()=>{
    const right=fixture();mutate(right);
    const {payload}=await capture(right);
    expect(payload.runtimeEvidence.caseFiles.status).toBe('NOT_VERIFIED');
    expect(payload.runtimeEvidence.caseFiles.files).toBeUndefined();
  });
});
it('counts repeated reads once per input file and preserves exact whitespace',async()=>{
  const right=fixture();const workspace=right.metadata.caseWorkspace as any;
  workspace.reads.push({...workspace.reads[0]});
  expect((await capture(right)).payload.runtimeEvidence.caseFiles.files[0].readCount).toBe(2);
  const changed=structuredClone(definition);changed.workspaceFiles![0]!.content+='\n';
  expect((await capture(right,changed)).payload.runtimeEvidence.caseFiles.status).toBe('NOT_VERIFIED');
});
it('does not invent file reading for an empty receipt list',async()=>{
  const right=fixture();(right.metadata.caseWorkspace as any).reads=[];right.toolCalls=[];
  const {payload}=await capture(right);
  expect(payload.runtimeEvidence.caseFiles.status).toBe('NO_READS_RECORDED');
  expect(payload.runtimeEvidence.caseFiles.files.every((file:any)=>file.status==='READ_NOT_RECORDED')).toBe(true);
});
it('omits this projection for cases without workspace inputs',async()=>{
  expect((await capture(fixture(),{...definition,workspaceFiles:[]})).payload.runtimeEvidence.caseFiles).toBeUndefined();
});
it('uses the same bounded projection for candidate and anonymous comparison judges',async()=>{
  const pack=await loadEvalPack('packs/finance/investment-research/eval.yaml');
  for(const kind of ['candidate','pairwise']){
    const requests:any[]=[];
    const adapter={adapterId:'controlled',complete:async(request:any)=>{
      requests.push(request);
      return {modelId:'test',content:JSON.stringify({confidence:'medium',summary:'Projection only',
        ...(kind==='pairwise'?{winner:'TIE'}:{}),dimensions:pack.judgeProfile.dimensions.map(d=>({id:d.id,
          ...(kind==='candidate'?{score:2}:{aScore:2,bScore:2}),reason:'Synthetic scoring'}))})};
    }};
    const Judge=kind==='candidate'?ModelCandidateJudge:ModelPairwiseJudge;
    const right=fixture();const left={...fixture(),side:'left' as const,output:'Different answer without quotation'};
    await new Judge(adapter,pack.models.judge).compare({evalCase:definition,left,right,profile:pack.judgeProfile});
    const payload=JSON.parse(requests[0].messages[1].content);
    if(kind==='candidate')expect(payload.runtimeEvidence.caseFiles.files[0].exactTextInAnswer.start).toBe(6);
    else {
      for(const label of ['A','B']){
        const quoted=payload[`output${label}`].includes(content);
        const span=payload[`runtimeEvidence${label}`].caseFiles.files[0].exactTextInAnswer;
        expect(span!==null).toBe(quoted);
      }
    }
    expect(JSON.stringify(requests)).not.toContain('PRIVATE_UNREAD_CONTENT');
  }
});
