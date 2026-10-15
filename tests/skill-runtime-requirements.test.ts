import {expect,it} from 'vitest';
import {skillRuntimeRequirements as tools} from '../src/shared/skill-runtime-requirements.js';

const skill=(header:string)=>`---\nname: sample\n${header}\n---\n# Method\n`;
it('keeps declared installation dependencies when only one case or tool is selected',()=>{
  expect(tools(skill('allowed-tools: [query_a, query_b]'),['query_a'])).toEqual(['query_a','query_b']);
  expect(tools(skill('allowed-tools: [query_a, query_b]'),[])).toEqual(['query_a','query_b']);
});
it('keeps per-case auxiliary tools separate and accepts explicit no-tool methods',()=>{
  expect(tools(skill('allowed-tools: []'),[])).toEqual([]);
  expect(tools(skill('allowed-tools: [query_a]'),['query_a','read_case_file'],['read_case_file']))
    .toEqual(['query_a','read_case_file']);
  expect(()=>tools(skill('allowed-tools: []'),['query_a'])).toThrow('案例工具');
  expect(()=>tools(skill('allowed-tools: []'),['read_case_file'])).toThrow('案例工具');
});
it('preserves old non-declarative input without guessing dependencies',()=>{
  expect(tools('# Method', ['query_a','query_a'])).toEqual(['query_a']);
  expect(tools(skill('description: Legacy'), ['query_b'])).toEqual(['query_b']);
});
it.each(['allowed-tools: [query_a, query_a]', 'allowed-tools: [42]', 'allowed-tools: ""',
  'allowed-tools: null', 'allowed-tools: {query_a: true}',
  'allowed-tools: ["*"]','allowed-tools: []\nallowed-tools: [query_a]',
  'allowed-tools: []\nallowedTools: [query_a]'])('rejects ambiguous declaration %s',declaration=>{
  expect(()=>tools(skill(declaration),[])).toThrow();
});
