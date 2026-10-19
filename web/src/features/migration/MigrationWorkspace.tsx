import { useState } from 'react';
import { api } from '../../api-client';
import type { Catalog, SkillAsset } from '../../types';
import type { BundleTask } from '../../../../src/migration/tasks/domain/task-model';
import { MigrationPanel } from '../../MigrationPanel';
import { MigrationTaskPanel } from './MigrationTaskPanel';

type LegacySource = { id: string; name: string; candidate: unknown; };
export function MigrationWorkspace({ catalog, source, onChanged, onUseAsset }: {
  catalog: Catalog; source: SkillAsset | null; onChanged(): Promise<void>;
  onUseAsset(asset: SkillAsset): Promise<void>;
}) {
  const [history, setHistory] = useState(false);
  const [legacy, setLegacy] = useState<LegacySource | null>(null);
  const [initialTask, setInitialTask] = useState<BundleTask | null>(null);
  const [selection, setSelection] = useState<'source' | 'candidate'>('source');
  const [goal, setGoal] = useState(''), [target, setTarget] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function transfer() {
    if (!legacy || busy) return;
    setBusy(true); setError('');
    try {
      const task = await api<BundleTask>('/api/migration-tasks/from-legacy/' + legacy.id, {
        method: 'POST', body: JSON.stringify({ name: legacy.name, goal, target, selection }),
      });
      setInitialTask(task); setLegacy(null); setHistory(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="workspace">
    <section className="workspace-header"><div><span className="eyebrow">SKILL MIGRATION</span><h1>Skill 迁移</h1></div>
      <button className="button secondary" onClick={() => { setHistory(!history); setLegacy(null); }}>
        {history ? '返回统一迁移' : '旧版任务记录'}
      </button>
    </section>
    {history ? <>
      <p>旧任务保留原来的逐 Tool 决策、验证、继续处理和导出。转入统一流程会新建任务，原记录与验收结论保留在这里。</p>
      {legacy && <section className="stage-section" aria-label="转入统一迁移">
        <h2>从旧任务创建统一迁移：{legacy.name}</h2>
        <label>导入版本<select value={selection} onChange={e => setSelection(e.target.value as 'source' | 'candidate')}>
          <option value="source">原始源码</option><option value="candidate" disabled={!legacy.candidate}>已有候选</option>
        </select></label>
        <label>业务目标<textarea value={goal} onChange={e => setGoal(e.target.value)} /></label>
        <label>目标环境与要求<input value={target} onChange={e => setTarget(e.target.value)} /></label>
        <p>复制所选资产作为新基线；运行配置、测试集和旧通过结论不自动继承。</p>
        {error && <p role="alert">{error}</p>}
        <button className="button primary" disabled={busy || !goal.trim() || !target.trim()} onClick={() => void transfer()}>创建统一任务</button>
      </section>}
      <MigrationPanel catalog={catalog} api={api} historyOnly onUseAsset={onUseAsset}
        onContinueUnified={project => { setLegacy(project); setSelection('source'); setError(''); }} />
    </> : <MigrationTaskPanel catalog={catalog} api={api} onChanged={onChanged} source={source} initialTask={initialTask} />}
  </div>;
}
