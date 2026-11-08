export const stages = [
  '上传工程',
  '诊断与迁移方案',
  '生成迁移结果',
  '准备运行环境',
  '基础验证',
  '验证实际效果',
  '下载结果',
];
/** Both original-project baseline and candidate execution honor the selected Runtime limit. */
export function fitRuntimeTimeout<T extends {timeoutMs:number}>(configuration:T,maxTimeoutMs?:number):T {
  return {...configuration,timeoutMs:Math.min(configuration.timeoutMs,maxTimeoutMs??configuration.timeoutMs)};
}

/** Compare the complete wire values, independent of object key insertion order. */
export function sameConfiguration(left: unknown, right: unknown): boolean {
  const wire=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
    ?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
  return wire(left)===wire(right);
}
export const sameEvaluationSuite=(left:unknown,right:unknown)=>sameConfiguration(suiteExecutionValue(left),suiteExecutionValue(right));
export const statusLabels: Record<string, string> = {
  PASSED: '通过',
  FAILED: '未通过',
  RUNNING: '执行中',
  WAITING:'等待外部调整',
  INCOMPLETE: '未完成',
  CANCELLED: '已取消',
  COMPLETED: '操作完成',
  INTERRUPTED: '已中断',
};
export function caseResultLabel(result:{passed:boolean;unverified?:boolean;failureStage?:'RUNTIME'|'EXECUTION'|'JUDGE'}) {
  if(result.failureStage==='RUNTIME')return '运行未完成';
  if(result.failureStage==='EXECUTION')return '执行检查未通过';
  if(result.failureStage==='JUDGE')return '评判未完成';
  return result.unverified?'无法验证':result.passed?'通过':'未通过';
}
export const sampleSuite = {
  name: '整组业务验收',
  cases: [
    {
      id: 'combined-001',
      input: '',
      criteria: [''],
    },
  ],
};
import {suiteExecutionValue} from './suite-form';
