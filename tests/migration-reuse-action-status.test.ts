import {it,expect} from 'vitest';
import {reuseActionMessage} from '../web/src/MigrationReuseAcceptance.js';

it('shows truthful combined model work rather than claiming an unobserved sub-phase',()=>{
 expect(reuseActionMessage('/plan',{})).toBe('正在生成计划并独立检查覆盖范围');
 expect(reuseActionMessage('/plan',{plan:{}})).toBe('正在检查并保存验收计划');
 expect(reuseActionMessage('/approve',{})).toBe('正在确认验收计划');
 expect(reuseActionMessage('/start',{})).toBe('正在启动复用验收');
});
