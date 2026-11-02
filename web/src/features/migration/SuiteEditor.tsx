import type { BundleTask } from '../../../../src/migration/tasks/domain/task-model';

type Suite = NonNullable<BundleTask['suite']>;

// A form must never replace imported data it cannot represent. Extra fields,
// fixtures and independent acceptance cases remain in the original JSON.
export function editableSuite(value: string): Suite | null {
  try {
    const suite = JSON.parse(value);
    if (!suite || typeof suite.name !== 'string' || !Array.isArray(suite.cases) || !suite.cases.length) return null;
    if (!suite.cases.every((item: Suite['cases'][number]) => item && typeof item.id === 'string' &&
      typeof item.input === 'string' && Array.isArray(item.criteria) && item.criteria.every(c => typeof c === 'string') && !item.turns?.length)) return null;
    return suite;
  } catch { return null; }
}

export function SuiteEditor({ value, onChange, disabled }: { value: string; onChange(value: string): void; disabled: boolean }) {
  const suite = editableSuite(value);
  const update = (next: Suite) => onChange(JSON.stringify(next, null, 2));
  return <section className="stage-secondary-card">
    <h4>用真实任务验证效果</h4>
    <p>填写希望 Skill 完成的任务，以及判断结果是否正确的标准。</p>
    {suite ? <>
      <label>测试名称<input disabled={disabled} value={suite.name} onChange={e => update({ ...suite, name: e.target.value })}/></label>
      {suite.cases.map((item, index) => <article className="stage-tool-card" key={index}>
        <h4>测试案例 {index + 1}</h4>
        <label>任务内容<textarea disabled={disabled} value={item.input} placeholder="例如：查询明天下午可容纳 6 人的空闲会议室。"
          onChange={e => update({ ...suite, cases: suite.cases.map((c, i) => i === index ? { ...c, input: e.target.value } : c) })}/></label>
        <label>预期结果（每行一条）<textarea disabled={disabled} value={item.criteria.join('\n')} placeholder="填写可以核验的结果或要求"
          onChange={e => update({ ...suite, cases: suite.cases.map((c, i) => i === index ? { ...c, criteria: e.target.value.split('\n') } : c) })}/></label>
        <button className="button secondary" disabled={disabled || suite.cases.length === 1}
          onClick={() => update({ ...suite, cases: suite.cases.filter((_, i) => i !== index) })}>移除案例</button>
      </article>)}
      <button className="button secondary" disabled={disabled || suite.cases.length >= 8}
        onClick={() => update({ ...suite, cases: [...suite.cases, { id: crypto.randomUUID(), input: '', criteria: [''] }] })}>添加案例</button>
      {!!suite.holdoutCases?.length && <p>另有 {suite.holdoutCases.length} 个独立验收案例，已保留，可在高级设置中查看。</p>}
    </> : <p role="status">当前测试内容含多轮对话或格式需要检查，请在高级设置中编辑；原始内容已保留。</p>}
    <details className="stage-detail" open={!suite}><summary>高级设置：导入与编辑测试集</summary>
      <p>可编辑完整测试集，包含测试文件、多轮对话和独立验收案例。</p>
      <label>验收测试集 JSON<textarea aria-label="验收测试集 JSON" disabled={disabled} className="bundle-suite" value={value} onChange={e => onChange(e.target.value)} spellCheck={false}/></label>
    </details>
  </section>;
}
