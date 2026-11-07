import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {DiagnosisStage} from '../web/src/features/migration/DiagnosisStage';
import type {MigrationWorkbench} from '../web/src/features/migration/useMigrationWorkbench';

it('keeps historical missing information visible without gating the main-Agent entry',()=>{
  const task={id:'task',analysis:{summary:'旧方案',changes:[],missing:['需要核实入口']},source:{members:[]},planRevisions:[]};
  const state={task,disabled:false,api:async()=>({}),act:async()=>{},setTask:()=>{},setStage:()=>{},setMessage:()=>{}} as unknown as MigrationWorkbench;
  const html=renderToStaticMarkup(createElement(DiagnosisStage,{state}));
  expect(html).toContain('原方案记录的待核对信息');
  expect(html).toContain('需要核实入口');
  expect(html).toContain('下一步：生成迁移结果');
  expect(html).not.toContain('确认方案并继续');
});
