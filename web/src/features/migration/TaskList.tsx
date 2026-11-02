import type { MigrationWorkbench } from './useMigrationWorkbench';
import type { BundleTask } from '../../../../src/migration/tasks/domain/task-model';
import { HistoryPanel } from '../history/HistoryPanel';
export function TaskEntry({ state }: { state: MigrationWorkbench; }) {
  const { catalog, api, name, setName, goal, setGoal, creationOptions, selected, setSelected, busy, zipInput, list, select, act, uploadZip, uploadingFile, uploadFileName, error } = state;
  return (
    <>
      <section className="migration-stage migration-entry">
        <div className="migration-stage-heading"><div><h3>上传需要迁移的工程</h3>
        <p>将 Skill 说明、源码、依赖声明和资源一起打包为一个 ZIP，保留原有目录结构。</p></div></div>
        <div className="diagnostic-finding"><h4>准备工程包</h4><p>压缩包名称不限，支持原有工程目录。工程中需包含至少一个 SKILL.md，系统会自动识别。</p><p>诊断会分析说明、源码与依赖，不会执行原始工具或修改原文件。</p></div>
        <div className="bundle-upload" aria-busy={Boolean(uploadingFile)}>
          <button className="button secondary" disabled={busy} onClick={() => zipInput.current?.click()}>
            {uploadingFile ? '正在上传…' : '上传工程 ZIP'}
          </button>
          {uploadingFile && <p role="status">正在上传并检查 {uploadingFile}，请稍候…</p>}
          {error && <div role="alert" className="bundle-upload-error">
            <strong>{uploadFileName ? `${uploadFileName} 导入失败` : '导入失败'}</strong>
            <p>{error}</p>
            {error.includes('SKILL.md 入口') && <p>请检查工程内的说明文件是否命名为大写 SKILL.md，再重新打包上传；当前任务尚未创建。</p>}
          </div>}
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
        <details className="migration-extra-options"><summary>补充要求（可选）</summary>
          <label>任务名称（可选）<input value={name} onChange={event => setName(event.target.value)} placeholder="留空时根据 Skill 名称生成"/></label>
          <label>额外业务要求（可选）<textarea value={goal} onChange={event => setGoal(event.target.value)} placeholder="仅填写原 Skill 之外需要补充或改变的要求"/></label>
        </details>
        <details open={selected.length > 0}><summary>或复用已导入的 Skill（已选 {selected.length}）</summary>
        <p className="bundle-member-hint">新工程请从上方整体上传，已有 Skill 仍可组合迁移。</p>
        <div className="bundle-member-options">
          {catalog.uploadedSkills.map((asset) => (
            <label key={asset.assetId}>
              <input
                type="checkbox"
                checked={selected.includes(asset.assetId)}
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
          disabled={busy || !selected.length}
          onClick={() =>
            void act(async () => {
              select(
                await api<BundleTask>('/api/migration-tasks', {
                  method: 'POST',
                  body: JSON.stringify({ ...creationOptions(), sourceAssetIds: selected }),
                }),
              );
              await list();
            })
          }
        >
          继续诊断
        </button>
        </details>
      </section>
    </>
  );
}

export function TaskList({ state }: { state: MigrationWorkbench }) {
  const { tasks, api, act, select } = state;
  return <>
      <section>
        <h3>迁移记录</h3>
        {tasks.length ? (
          <div className="migration-project-list">{tasks.map((item) => (
            <article className="migration-project" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <p>
                  {item.source.members.length} 个 Skill · {item.candidates.length} 个版本 ·{' '}
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
          ))}</div>
        ) : (
          <p>尚未创建迁移任务。</p>
        )}
      </section>
      <HistoryPanel kind="tasks" api={api}/>
  </>;
}
