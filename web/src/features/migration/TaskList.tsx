import type { MigrationWorkbench } from './useMigrationWorkbench';
import type { BundleTask } from '../../../../src/migration/tasks/domain/task-model';
export function TaskList({ state }: { state: MigrationWorkbench; }) {
  const { catalog, api, tasks, name, setName, goal, setGoal, target, setTarget, selected, setSelected, busy, zipInput, filesInput, list, select, act, uploadZip, uploadMembers } = state;
  return (
    <>
      <section className="stage-section">
        <h3>新建迁移任务</h3>
        <div className="bundle-fields">
          <label>
            任务名称
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：采购审核迁移"
            />
          </label>
          <label>
            目标环境与要求
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="目标平台、工具形式和运行限制"
            />
          </label>
          <label className="bundle-full">
            业务目标
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="需要完成什么业务任务？"
            />
          </label>
        </div>
        <div className="bundle-actions">
          <button className="button secondary" disabled={busy} onClick={() => zipInput.current?.click()}>
            导入工程 ZIP
          </button>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => filesInput.current?.click()}
          >
            导入 Skill 文件
          </button>
        </div>
        <input
          ref={zipInput}
          hidden
          type="file"
          accept=".zip"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void act(() => uploadZip(file));
            e.target.value = '';
          }}
        />
        <input
          ref={filesInput}
          hidden
          type="file"
          multiple
          accept=".zip,.md"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) void act(() => uploadMembers(files));
            e.target.value = '';
          }}
        />
        <h4>从已有资产选择成员（已选 {selected.length}/10）</h4>
        <div className="bundle-member-options">
          {catalog.uploadedSkills.map((asset) => (
            <label key={asset.assetId}>
              <input
                type="checkbox"
                checked={selected.includes(asset.assetId)}
                disabled={!selected.includes(asset.assetId) && selected.length >= 10}
                onChange={(e) =>
                  setSelected((old) =>
                    e.target.checked ? [...old, asset.assetId] : old.filter((id) => id !== asset.assetId),
                  )
                }
              />
              {asset.displayName} · {asset.version}
            </label>
          ))}
        </div>
        <button
          className="button primary"
          disabled={busy || !selected.length || selected.length > 10 || !name.trim() || !goal.trim() || !target.trim()}
          onClick={() =>
            void act(async () => {
              select(
                await api<BundleTask>('/api/migration-tasks', {
                  method: 'POST',
                  body: JSON.stringify({ name, goal, target, sourceAssetIds: selected }),
                }),
              );
              await list();
            })
          }
        >
          创建迁移任务
        </button>
      </section>
      <section className="stage-section">
        <h3>已有迁移任务</h3>
        {tasks.length ? (
          tasks.map((item) => (
            <article className="bundle-task-row" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <p>
                  {item.source.members.length} 个 Skill · {item.candidates.length} 个候选 ·{' '}
                  {item.runs.length} 次验收
                </p>
              </div>
              <button
                className="button secondary"
                onClick={() =>
                  void act(async () => select(await api<BundleTask>('/api/migration-tasks/' + item.id)))
                }
              >
                继续处理
              </button>
            </article>
          ))
        ) : (
          <p>尚未创建迁移任务。</p>
        )}
      </section>
    </>
  );
}
