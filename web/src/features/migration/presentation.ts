export const stages = [
  '选择 Skill',
  '诊断与迁移方案',
  '生成迁移结果',
  '选择与配置 Runtime',
  '启动检查',
  '联合验收',
  '导出交付',
];
export const statusLabels: Record<string, string> = {
  PASSED: '通过',
  FAILED: '未通过',
  RUNNING: '执行中',
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
      input: '请使用相关 Skill 完成实际业务任务（替换为你的任务）。',
      criteria: ['填写可核验的业务结果及数值。', '填写异常处理或证据要求。'],
    },
  ],
};
