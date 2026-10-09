import {expect,it} from 'vitest';
import {WorkspaceRequestBudget,requiresWorkspaceBudget,isWorkspacePreflight} from '../src/service/workspace-request-budget.js';

it('bounds one account without consuming another account allowance',()=>{
  let now=0;
  const budget=new WorkspaceRequestBudget({perAccount:2,global:3,windowSeconds:60},()=>now);
  expect(budget.take('a')).toBeNull();expect(budget.take('a')).toBeNull();
  expect(budget.take('a')).toEqual({scope:'ACCOUNT',retryAfterSeconds:60});
  expect(budget.take('b')).toBeNull();
  expect(budget.take('c')).toEqual({scope:'SERVICE',retryAfterSeconds:60});
  now=59999;expect(budget.take('b')?.retryAfterSeconds).toBe(1);
  now=60000;expect(budget.take('a')).toBeNull();
});

it('uses a rolling window and does not refill on rejected requests',()=>{
  let now=0;
  const budget=new WorkspaceRequestBudget({perAccount:1,global:2,windowSeconds:60},()=>now);
  expect(budget.take('a')).toBeNull();now=30000;expect(budget.take('b')).toBeNull();
  expect(budget.take('a')?.retryAfterSeconds).toBe(30);
  now=60000;expect(budget.take('a')).toBeNull();
  expect(budget.take('b')).toEqual({scope:'SERVICE',retryAfterSeconds:30});
});

it.each([
  ['POST','/api/skills/upload',true],['POST','/api/skills/a/prepare',true],
  ['POST','/api/runs',true],['POST','/api/runs/a/retry',true],
  ['POST','/api/migrations/a/analyze',true],['POST','/api/migrations/a/generate',true],
  ['PUT','/api/migrations/a/tools/b/decision',true],
  ['GET','/api/migrations/a/diagnosis?view=all',true],
  ['GET','/api/migrations/a/report',true],['GET','/api/migrations/a/export',true],
  ['GET','/api/migrations/a/inspection',true],
  ['GET','/api/migrations/a/%64iagnosis',true],
  ['GET','/api/runs/a/export',false],['GET','/api/runs/a/events',false],
  ['GET','/api/catalog',false],['GET','/api/migrations',false],
  ['POST','/api/runs/a/cancel',false],['POST','/api/optimizations/a/decision',false],
  ['POST','/api/environments/env-a/preflight',false],
  ['DELETE','/api/unknown/new-route',true],['OPTIONS','/api/runs',false],
])('classifies %s %s without blocking cancellation', (method,route,expected)=>{
  expect(requiresWorkspaceBudget(method,route)).toBe(expected);
});

it('recognizes only the non-executing preflight route',()=>{
  expect(isWorkspacePreflight('POST','/api/environments/env-a/%70reflight?x=1')).toBe(true);
  expect(isWorkspacePreflight('PUT','/api/environments/env-a/preflight')).toBe(false);
  expect(isWorkspacePreflight('POST','/api/environments/env-a')).toBe(false);
  expect(isWorkspacePreflight('POST','/api/environments/env-a/preflight/execute')).toBe(false);
});

it.each([
  {perAccount:0,global:10,windowSeconds:60},
  {perAccount:10,global:5,windowSeconds:60},
  {perAccount:1.5,global:10,windowSeconds:60},
  {perAccount:1,global:10,windowSeconds:0},
  {perAccount:1,global:10001,windowSeconds:60},
])('rejects invalid limits %j',limits=>{
  expect(()=>new WorkspaceRequestBudget(limits)).toThrow('WORKSPACE_REQUEST_BUDGET_INVALID');
});
