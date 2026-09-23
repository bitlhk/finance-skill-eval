import type { ProjectInspection } from './migration-model.js';

/** Build the grounded context that constrains migration-suite case generation. */
export function baselineBrief(inspection: ProjectInspection): string {
  const tools = inspection.tools.map(tool => {
    const lines = [`### ${tool.name}`];
    if (tool.inputSchema) lines.push(`输入 Schema：${JSON.stringify(tool.inputSchema)}`);
    if (tool.outputSchema) lines.push(`输出 Schema：${JSON.stringify(tool.outputSchema)}`);
    const described = tool.evidence.filter(item => item.detail).map(item => `${item.detail}（${item.path}:${item.line}）`);
    if (described.length) lines.push(`Skill 里的说明：${described.join('；')}`);
    const samples = tool.samples.slice(0, 2).map(sample => JSON.stringify(sample.input));
    if (samples.length) lines.push(`Skill 文档中出现的样例输入：${samples.join('、')}`);
    return lines.join('\n');
  });
  return [
    '# 这个 Skill 实际调用的工具（来自对 Skill 的分析）',
    '',
    '出题只能围绕这些工具，`requiredTools` 只能从中选择。工具接受的输入形状就是下面写的这些，',
    '不要发明工具里不存在的业务对象。',
    '',
    ...tools,
  ].join('\n');
}
