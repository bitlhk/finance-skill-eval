import type { Activity } from '../../../../src/migration/domain/migration-activity';

/** Describe observed events; elapsed time is not evidence of progress. */
export function activitySummary(activity: Activity, now: number): string {
  if (activity.status !== 'RUNNING') return {COMPLETED:'执行结束',FAILED:'执行失败',CANCELLED:'已取消',INTERRUPTED:'执行已中断'}[activity.status];
  const event = activity.events.at(-1);
  if (!event) return '正在获取执行进度…';
  if (event.kind === 'model_start') {
    const seconds = Math.max(0, Math.floor((now - Date.parse(event.at)) / 1000));
    return `正在等待模型响应${seconds >= 10 ? `，已等待 ${seconds} 秒` : ''}`;
  }
  if (event.kind === 'text_snapshot') return '正在接收模型响应';
  if (event.kind === 'model_end') return '模型已返回，正在处理结果';
  if (event.kind === 'tool_start') {
    if (/read_file/.test(event.label)) return '正在读取工程文件';
    if (/glob|grep|list_files/.test(event.label)) return '正在检索工程文件与依赖';
    return '正在执行本阶段的工具操作';
  }
  if (event.kind === 'tool_end') return '工具操作已完成，正在继续处理';
  return event.label;
}
