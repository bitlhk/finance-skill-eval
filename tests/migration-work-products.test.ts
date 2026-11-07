import {expect,it} from 'vitest';
import {workProducts} from '../web/src/features/migration/work-products.js';

it('keeps earlier plans while projecting each work product to its latest version',()=>{
  const products=workProducts([
    {sequence:1,kind:'work_product',payload:{id:'migration',title:'迁移方案',content:'初始方案'}},
    {sequence:2,kind:'message',payload:{text:'继续验证'}},
    {sequence:3,kind:'work_product',payload:{id:'optimization',title:'优化方案',content:'目标'}},
    {sequence:4,kind:'work_product',payload:{id:'migration',title:'迁移方案',content:'更新方案',workspaceDigest:'revision-1'}},
    {sequence:5,kind:'work_product',payload:{id:'broken'}},
  ]);
  expect([...products.keys()]).toEqual(['migration','optimization']);
  expect(products.get('migration')?.map(version=>version.content)).toEqual(['初始方案','更新方案']);
  expect(products.get('migration')?.at(-1)?.workspaceDigest).toBe('revision-1');
  expect(products.get('optimization')?.at(-1)?.content).toBe('目标');
});
