import type { MigrationWorkbench } from './useMigrationWorkbench';
import type { BundleTask } from '../../../../src/migration/tasks/domain/task-model';
export function TaskList({ state }: { state: MigrationWorkbench; }) {
  const { assets, setAssets, catalog, api, tasks, name, setName, goal, setGoal, target, setTarget, selected, setSelected, busy, zipInput, filesInput, list, select, act, uploadZip, uploadMembers } = state;
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
              aria-label="业务目标"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="需要完成什么业务任务？"
            />
          </label>
        </div>
        <div className="bundle-actions">
          <button className="button secondary" disabled={busy} onClick={() => zipInput.current?.click()}>
            导入 Skill ZIP（可选）
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
        <p>选择 1～10 个 Skill 即可创建任务，不需要完整工程。脚本与共享资源按需添加。</p>
        <details><summary>依赖文件（可选，已选 {assets.length} 个）</summary>
          <label>添加依赖文件<input aria-label="添加依赖文件" type="file" multiple onChange={e => {
            const files=Array.from(e.target.files??[]); e.target.value='';
            void act(async()=>{
              const next=await Promise.all(files.map(async file=>({id:crypto.randomUUID(),path:'shared/'+file.name,
                content:btoa(Array.from(new Uint8Array(await file.arrayBuffer()),byte=>String.fromCharCode(byte)).join(''))})));
              setAssets(old=>[...old,...next]);
            });
          }}/></label>
          <p>路径相对任务工作区；保留 Skill 引用的共享路径。没有依赖时留空。</p>
          {assets.map(asset=><div className="bundle-fields" key={asset.id}>
            <label>依赖文件路径<input aria-label="依赖文件路径" value={asset.path} onChange={e=>setAssets(old=>old.map(item=>item.id===asset.id?{...item,path:e.target.value}:item))}/></label>
            <button className="button secondary" onClick={()=>setAssets(old=>old.filter(item=>item.id!==asset.id))}>移除依赖</button>
          </div>)}
        </details>
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
              if(new Set(assets.map(asset=>asset.path.toLowerCase())).size!==assets.length)throw new Error('依赖文件路径不能重复');
              select(
                await api<BundleTask>('/api/migration-tasks', {
                  method: 'POST',
                  body: JSON.stringify({ name, goal, target, sourceAssetIds: selected, assets:Object.fromEntries(assets.map(asset=>[asset.path,asset.content])) }),
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
