import {expect,it} from 'vitest';
import {EvaluationRunBudget} from '../src/service/evaluation-run-budget.js';

it('shares a FIFO limit across accounts and does not execute cancelled waiting tasks',async()=>{
  const budget=new EvaluationRunBudget(1),order:string[]=[];
  let release!:()=>void;
  const first=budget.schedule(async()=>{order.push('alice');await new Promise<void>(resolve=>{release=resolve;});},new AbortController().signal);
  await Promise.resolve();
  const cancelled=new AbortController();
  const second=budget.schedule(async()=>{order.push('cancelled');},cancelled.signal);
  const third=budget.schedule(async()=>{order.push('bob');},new AbortController().signal);
  cancelled.abort();await second;
  expect(order).toEqual(['alice']);release();await Promise.all([first,third]);
  expect(order).toEqual(['alice','bob']);
});

it('releases capacity after failure and rejects invalid limits',async()=>{
  expect(()=>new EvaluationRunBudget(0)).toThrow('LIMIT');
  const budget=new EvaluationRunBudget(1);
  await expect(budget.schedule(async()=>{throw new Error('controlled');},new AbortController().signal)).rejects.toThrow('controlled');
  let called=0;await budget.schedule(async()=>{called++;},new AbortController().signal);expect(called).toBe(1);
  const cancelled=new AbortController();cancelled.abort();
  await budget.schedule(async()=>{called++;},cancelled.signal);expect(called).toBe(1);
});
