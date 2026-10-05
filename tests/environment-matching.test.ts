import {expect,it} from 'vitest';
import {matchEnvironments,chooseEnvironment} from '../web/src/environment-matching.js';
import {describeSkillRuntimeRequirements} from '../src/service/skill-runtime-requirements.js';
import type {MigrationRuntime} from '../web/src/types.js';

function runtime(id:string,family:'openjiuwen'|'agentscope',names:string[],minimum=1):MigrationRuntime{
  return {runtimeId:id,runtimeType:family,inspection:{status:'ready',error:null,tools:[],
    capabilities:{nativeToolNames:names,auxiliaryToolNames:['read_case_file'],features:{externalMcp:false},limits:{minPrimaryTools:minimum}}}} as MigrationRuntime;
}
const options=[runtime('bank-oj','openjiuwen',['balance','read_case_file']),runtime('curated-oj','openjiuwen',['audit']),
  runtime('bank-as','agentscope',['balance','read_case_file']),runtime('curated-as','agentscope',['audit']),
  runtime('plain-oj','openjiuwen',[],0),runtime('plain-as','agentscope',[],0)];
it('matches both frameworks by actual dependency rather than catalog order',()=>{
  const rows=matchEnvironments(options,['audit']);
  expect(chooseEnvironment(rows,'openjiuwen','bank-oj')).toBe('curated-oj');
  expect(chooseEnvironment(rows,'agentscope','')).toBe('curated-as');
});
it('changes the matching pair when Skill dependencies change',()=>{
  const rows=matchEnvironments(options,['balance','read_case_file']);
  expect(chooseEnvironment(rows,'openjiuwen','curated-oj')).toBe('bank-oj');
  expect(chooseEnvironment(rows,'agentscope','curated-as')).toBe('bank-as');
});
it('routes explicitly tool-free methods only to compatible no-tool environments',()=>{
  expect(chooseEnvironment(matchEnvironments(options,[]),'openjiuwen','')).toBe('plain-oj');
});
it('does not infer external tools merely from externalMcp support',()=>{
  const unknown=runtime('external','openjiuwen',[],0);
  unknown.inspection!.capabilities!.features.externalMcp=true;
  expect(matchEnvironments([unknown],['missing'])[0]!.issues).toContain('缺少已准入工具：missing');
});
it('does not pick the first among multiple compatible sources',()=>{
  const rows=matchEnvironments([...options,runtime('other-bank','openjiuwen',['balance'])],['balance']);
  expect(chooseEnvironment(rows,'openjiuwen','')).toBe('');
  expect(chooseEnvironment(rows,'openjiuwen','other-bank')).toBe('other-bank');
});
it('rejects unknown and uninspected environments',()=>{
  const rows=matchEnvironments([{...options[0]!,inspection:undefined}],['balance']);
  expect(chooseEnvironment(rows,'openjiuwen','bank-oj')).toBe('');
  expect(chooseEnvironment(matchEnvironments(options,['unregistered']),'agentscope','')).toBe('');
});
it('distinguishes explicit tool-free, missing and invalid declarations',()=>{
  expect(describeSkillRuntimeRequirements('---\nallowed-tools: []\n---\nMethod')).toEqual({status:'declared',tools:[]});
  expect(describeSkillRuntimeRequirements('# Method').status).toBe('unspecified');
  expect(describeSkillRuntimeRequirements('---\nallowed-tools: ["*"]\n---\nMethod').status).toBe('invalid');
  expect(describeSkillRuntimeRequirements('---\nallowed-tools: [b, a]\n---\nMethod').tools).toEqual(['a','b']);
});
