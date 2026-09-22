import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {manualPreparationSchema} from '../../src/service/contracts.ts';
import {runtimeToolConfigSchema} from '../../src/runtime-tool-config.ts';

const root=path.dirname(fileURLToPath(import.meta.url));
for(const name of (await readdir(root)).filter(name=>/^0[1-4]-/.test(name))){
  const read=async filename=>JSON.parse(await readFile(path.join(root,name,filename),'utf8'));
  manualPreparationSchema.parse(await read('suite.json'));
  runtimeToolConfigSchema.parse(await read('runtime-config.json'));
}
const expenseScript=await readFile(path.join(root,'01-expense/source/scripts/check_expense.py'),'utf8');
assert.doesNotMatch(expenseScript,/agentscope|Toolkit|build_toolkit/u,'独立 Script 案例不能绑定 AgentScope Runtime');
const procurementSkill=await readFile(path.join(root,'03-procurement/source/SKILL.md'),'utf8');
for(const required of ['## 输入','## 审批流程','## 工具职责','## 输出','BUDGET_EXCEEDED','SUPPLIER_INACTIVE'])assert.match(procurementSkill,new RegExp(required),'采购 Skill 必须包含可执行的业务流程与输出契约');
console.log('4 suites and 4 Runtime configurations match current platform schemas.');
