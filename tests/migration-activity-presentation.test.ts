import {expect,it} from 'vitest';
import {activitySummary} from '../web/src/features/migration/activity-presentation.js';
import type {Activity} from '../src/migration/domain/migration-activity.js';

it('reports actual file activity and model waits without inventing progress',()=>{
  const at='2026-10-31T00:00:00.000Z',now=Date.parse(at)+44000;
  const activity:Activity={taskId:'attempt-one',status:'RUNNING',startedAt:at,updatedAt:at,events:[]};
  expect(activitySummary(activity,now)).toBe('正在获取执行进度…');
  activity.events=[{id:1,kind:'tool_start',label:'调用工具：read_file',at}];
  expect(activitySummary(activity,now)).toBe('正在读取工程文件');
  activity.events.push({id:2,kind:'model_start',label:'等待模型响应',at});
  expect(activitySummary(activity,now)).toBe('正在等待模型响应，已等待 44 秒');
  activity.events.push({id:3,kind:'text_snapshot',label:'接收模型响应',at});
  expect(activitySummary(activity,now)).toBe('正在接收模型响应');
  activity.status='COMPLETED';
  expect(activitySummary(activity,now)).toBe('执行结束');
});
