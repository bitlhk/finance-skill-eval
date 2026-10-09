import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {RuntimeAdaptationStep} from '../web/src/MigrationPanel.js';
import {HarnessCapabilities} from '../web/src/DiagnosisStep.js';

it('describes source capability dependencies without asserting the target is missing them',()=>{
 const html=renderToStaticMarkup(createElement(HarnessCapabilities,{
  capabilities:[{name:'read_file',owner:'RUNTIME_HARNESS',migrationAction:'REQUIRES_RUNTIME_BUILDER',blocking:true,reason:'Read Skill references',usageContract:'relative path -> content',targetCapability:null,testAvailability:'UNCHECKED',consumerTools:[],evidence:[]}],download:()=>{},
 }));
 expect(html).toContain('需要核对的 Runtime 能力');expect(html).toContain('目标 Runtime 能力：待核对');
 expect(html).not.toContain('尚未提供');expect(html).not.toContain('需要 Runtime Harness 改造');
});

it('does not present incomplete capability contracts as no adaptation required',()=>{
  const html=renderToStaticMarkup(createElement(RuntimeAdaptationStep,{
    incomplete:[{name:'native.session',fields:['contract','constraints']}],trustReferences:[],busy:false,
    download:()=>{},importResult:async()=>{},next:()=>{},
  }));
  expect(html).toContain('能力需求待补充');expect(html).toContain('native.session');
  expect(html).toContain('输入、输出和错误语义');expect(html).toContain('权限、副作用及隔离要求');
  expect(html).not.toContain('无需适配');expect(html).not.toContain('<button');
});

it('offers existing Runtime discovery before Builder without claiming an untested capability is missing',()=>{
 const html=renderToStaticMarkup(createElement(RuntimeAdaptationStep,{
  capabilities:[{name:'read_file',reason:'read resources',consumerTools:[],contract:{semantics:'relative paths'}}],
  runtimes:[{runtimeId:'env-existing',name:'Existing Runtime'}],checkExisting:()=>{},reinspect:()=>{},trustReferences:[],busy:false,
  download:()=>{},importResult:async()=>{},next:()=>{},
 }));
 expect(html).toContain('核对并使用');expect(html).toContain('结合此 Runtime 重新诊断');
 expect(html).not.toContain('当前 Runtime 不能提供');expect(html).not.toContain('无需适配');
});

it('distinguishes reused native contracts from Builder delivery and business acceptance',()=>{
 const html=renderToStaticMarkup(createElement(RuntimeAdaptationStep,{
  reuse:{environmentId:'env-existing',launcherEnvironmentId:'env-existing',environmentUpdatedAt:'now',requirementsDigest:'a'.repeat(64),capabilitiesDigest:'b'.repeat(64),checkedAt:'now'},
  trustReferences:[],busy:false,download:()=>{},importResult:async()=>{},next:()=>{},
 }));
 expect(html).toContain('可复用现有能力');expect(html).toContain('尚未代表业务验收通过');expect(html).toContain('验证能否运行');
 expect(html).not.toContain('Builder Launcher 已验收');
});
