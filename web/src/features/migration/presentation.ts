export const stages = [
  '上传工程',
  '诊断与迁移方案',
  '生成迁移结果',
  '准备运行环境',
  '验证能否运行',
  '验证实际效果',
  '下载结果',
];
/** Compare the complete wire values, independent of object key insertion order. */
export function sameConfiguration(left: unknown, right: unknown): boolean {
  const wire=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
    ?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
  return wire(left)===wire(right);
}
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
