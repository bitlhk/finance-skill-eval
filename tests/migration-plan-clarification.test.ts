import {expect,it,vi} from 'vitest';
import {clarifyMigrationPlan} from '../web/src/features/migration/request-migration-work';
import type {MigrationApi} from '../web/src/features/migration/useMigrationTask';

it('sends plan and tool refinements to the existing Agent conversation',async()=>{
  const api=vi.fn(async()=>({task:{id:'task one'}})) as unknown as MigrationApi;
  const result=await clarifyMigrationPlan(api,'task one','request-key','会议室工具采用 MCP，并保留原权限');
  expect(result).toEqual({id:'task one'});
  expect(api).toHaveBeenCalledOnce();
  const [url,options]=vi.mocked(api).mock.calls[0]!;
  expect(url).toBe('/api/migration-tasks/task%20one/conversation/message');
  expect(JSON.parse(String(options?.body))).toMatchObject({key:'request-key',text:expect.stringContaining('会议室工具采用 MCP，并保留原权限')});
});
