import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {ValidationStep} from '../web/src/MigrationPanel';
import {inspectionFixture,toolFixture} from './analysis-fixture.js';

function view(available:boolean,kind:'SCRIPT'|'MCP'='SCRIPT'){
  const tool=toolFixture({name:'trial',kind,sourcePaths:['scripts/run.mjs'],inputSchema:{type:'object',properties:{}}});
  return renderToStaticMarkup(createElement(ValidationStep,{
    availability:{available,mode:'ISOLATED_CONTAINER',reason:available?null:'尚未配置隔离试运行环境'},
    api:async()=>({}) as never,refresh:async()=>{},inspection:inspectionFixture([tool]) as never,
    project:{id:'migration-synthetic'} as never,report:null,currentValidations:[],
    toolInputs:{},setToolInputs:()=>{},toolEndpoints:{},setToolEndpoints:()=>{},validateTool:()=>{},busy:false,next:()=>{},
  }));
}

it('shows why trials are unavailable and disables the trial button before a request',()=>{
  const html=view(false);
  expect(html).toContain('尚未配置隔离试运行环境');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^]*?开始试运行/u);
});
it('lets accounts trial scripts when the isolated executor is configured',()=>{
  const html=view(true);
  expect(html).not.toContain('尚未配置隔离试运行环境');
  expect(html).toMatch(/<button class="button primary"><svg[^]*?开始试运行/u);
});
it('does not ask isolated-trial users for an external MCP endpoint',()=>{
  const html=view(true,'MCP');
  expect(html).not.toContain('共享 MCP 服务地址');
  expect(html).toContain('请先生成包含启动命令的 MCP 候选');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^]*?开始试运行/u);
});
