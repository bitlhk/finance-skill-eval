import {expect,it} from 'vitest';
import {runtimeExecutionEvidenceSchema} from '../src/contracts.js';
import {verifiedToolProcessEvidence} from '../src/runtime-tool-process-evidence.js';
import {readFile} from 'node:fs/promises';
import {runtimeLauncherCapabilitiesSchema} from '../src/shared/contracts/runtime-launcher.js';
const record={callIndex:0,tool:'calculate',processScopeId:'process-opaque-one',startedAt:'2026-10-11T08:00:00.000Z',
  exitedAt:'2026-10-11T08:00:01.000Z',exitCode:0,argumentsDigest:'a'.repeat(64),resultDigest:'b'.repeat(64)};
function fixture(){return runtimeExecutionEvidenceSchema.parse({runId:'r',caseId:'c',side:'right',status:'completed',modelId:'m',skillVersion:null,
  output:'done',elapsedMs:1,runtimeIdentityVerified:true,streamCompleted:true,error:null,toolCalls:[{name:'calculate',status:'completed'}],
  metadata:{caseScopeId:'case-one',toolEvidence:[{tool:'calculate',status:'completed',argumentsDigest:record.argumentsDigest,resultDigest:record.resultDigest}],
    toolProcessEvidence:{schemaVersion:'finance.runtime-tool-process-evidence.v1',scope:'LAUNCHER_MANAGED_SCRIPT_CALLS',caseScopeId:'case-one',records:[{...record}]}}});}
it('correlates actual completed Script calls without exposing digests or claiming OS isolation',()=>{
  const result=verifiedToolProcessEvidence(fixture());expect(result.status).toBe('CORRELATED');expect(result.records).toEqual([
    {callIndex:0,tool:'calculate',processScopeId:'process-opaque-one',startedAt:record.startedAt,exitedAt:record.exitedAt,exitCode:0}]);
  expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
});
it.each(['unverified','scope','index','tool','failed-call','digest','exit','time','duplicate-call','duplicate-process','extra-private-field'])(
  'does not trust malformed or uncorrelated evidence: %s',change=>{
    const evidence=fixture(),receipt=evidence.metadata.toolProcessEvidence as any,r=receipt.records[0];
    if(change==='unverified')evidence.runtimeIdentityVerified=false;
    if(change==='scope')receipt.caseScopeId='other';
    if(change==='index')r.callIndex=8;
    if(change==='tool')r.tool='other';
    if(change==='failed-call')evidence.toolCalls[0]!.status='failed';
    if(change==='digest')r.resultDigest='c'.repeat(64);
    if(change==='exit')r.exitCode=1;
    if(change==='time')r.startedAt='2026-10-11T09:00:00.000Z';
    if(change==='duplicate-call')receipt.records.push({...r,processScopeId:'another'});
    if(change==='duplicate-process'){evidence.toolCalls.push({...evidence.toolCalls[0]!});(evidence.metadata.toolEvidence as any[]).push({...((evidence.metadata.toolEvidence as any[])[0])});receipt.records.push({...r,callIndex:1});}
    if(change==='extra-private-field')r.hostPath='PRIVATE_PATH';
    expect(verifiedToolProcessEvidence(evidence)).toEqual({status:'INVALID',records:[]});
  });
it('retains absence as unknown instead of inferring independent processes from calls',()=>{
  const evidence=fixture();delete evidence.metadata.toolProcessEvidence;
  expect(verifiedToolProcessEvidence(evidence)).toEqual({status:'NOT_COLLECTED',records:[]});
  evidence.metadata.toolProcessEvidence={schemaVersion:'finance.runtime-tool-process-evidence.v1',scope:'LAUNCHER_MANAGED_SCRIPT_CALLS',caseScopeId:'case-one',records:[]};
  expect(verifiedToolProcessEvidence(evidence)).toEqual({status:'NOT_COLLECTED',records:[]});
});
it('publishes an additive optional capabilities flag and portable strict receipt schema',async()=>{
  const base=JSON.parse(await readFile(new URL('../contracts/runtime-launcher/examples/builder-capabilities.json',import.meta.url),'utf8'));
  expect(runtimeLauncherCapabilitiesSchema.parse(base).features.toolProcessEvidence).toBeUndefined();
  expect(runtimeLauncherCapabilitiesSchema.parse(base).executionEnvironment).toBeUndefined();
  const measured={software:[{name:'python',version:'3.12.9'},{name:'fastmcp',version:'2.14.7'}]};
  expect(runtimeLauncherCapabilitiesSchema.parse({...base,executionEnvironment:measured}).executionEnvironment).toEqual(measured);
  expect(runtimeLauncherCapabilitiesSchema.safeParse({...base,executionEnvironment:{...measured,hostPath:'PRIVATE'}}).success).toBe(false);
  expect(runtimeLauncherCapabilitiesSchema.parse({...base,features:{...base.features,toolProcessEvidence:true}}).features.toolProcessEvidence).toBe(true);
  const schema=JSON.parse(await readFile(new URL('../contracts/runtime-launcher/finance.runtime-tool-process-evidence.v1.schema.json',import.meta.url),'utf8'));
  expect(schema).toMatchObject({$id:'finance.runtime-tool-process-evidence.v1',additionalProperties:false});
  expect(schema.properties.records.items.required).toEqual(Object.keys(record));
});
