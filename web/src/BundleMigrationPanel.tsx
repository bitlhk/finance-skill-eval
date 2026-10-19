import { useEffect, useRef, useState } from 'react';
import type { Catalog } from './types';
import type { BundleTask, BundleConfiguration, BundleRun } from '../../src/migration/bundle/bundle-model';
import { downloadApi } from './api-path';
import { importMigrationFiles } from './migration-import';
import './bundle-migration.css';

type Api = <T>(url: string, init?: RequestInit) => Promise<T>;
const stages = [
  '选择 Skill',
  '诊断与迁移方案',
  '生成迁移结果',
  'Runtime 适配与登记',
  '验证能否运行',
  '联合验收',
  '下载结果',
];
const statusLabels: Record<string, string> = {
  PASSED: '通过',
  FAILED: '未通过',
  RUNNING: '执行中',
  INCOMPLETE: '未完成',
  CANCELLED: '已取消',
  COMPLETED: '操作完成',
  INTERRUPTED: '已中断',
};
const sampleSuite = {
  name: '整组业务验收',
  cases: [
    {
      id: 'combined-001',
      input: '请使用相关 Skill 完成实际业务任务（替换为你的任务）。',
      criteria: ['填写可核验的业务结果及数值。', '填写异常处理或证据要求。'],
    },
  ],
};
export function BundleMigrationPanel({
  catalog,
  api,
  onChanged,
}: {
  catalog: Catalog;
  api: Api;
  onChanged(): Promise<void>;
}) {
  const [tasks, setTasks] = useState<BundleTask[]>([]),
    [task, setTask] = useState<BundleTask | null>(null),
    [stage, setStage] = useState(0);
  const [name, setName] = useState(''),
    [goal, setGoal] = useState(''),
    [target, setTarget] = useState(''),
    [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [config, setConfig] = useState<BundleConfiguration>({
    environmentId: '',
    modelId: '',
    timeoutMs: 310000,
    harnessTools: catalog.managedWorkspace ? [] : ['read_file', 'glob', 'list_files'],
  });
  const [suite, setSuite] = useState(JSON.stringify(sampleSuite, null, 2)),
    [preview, setPreview] = useState<{ path: string; before: string; after: string } | null>(null),
    [runId, setRunId] = useState('');
  const zipInput = useRef<HTMLInputElement>(null),
    filesInput = useRef<HTMLInputElement>(null);
  const current = task?.candidates.find((c) => c.id === task.currentCandidateId),
    active = task?.attempts.find((a) => a.status === 'RUNNING');
  const latestAttempt = task?.attempts[task.attempts.length - 1],
    run = task?.runs.find((r) => r.id === runId) ?? task?.runs[task.runs.length - 1];
  const runtime = catalog.executionRuntimes.find((r) => r.runtimeId === config.environmentId);
  async function list() {
    setTasks(await api<BundleTask[]>('/api/migration-bundles'));
  }
  useEffect(() => {
    void list().catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    if (!task || !active) return;
    let disposed = false;
    const timer = setInterval(() => {
      void api<BundleTask>('/api/migration-bundles/' + task.id)
        .then((next) => {
          if (!disposed) setTask(next);
        })
        .catch((e) => {
          if (!disposed) setError(String(e));
        });
    }, 1500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [task?.id, active?.id]);
  function select(next: BundleTask) {
    setTask(next);
    setConfig(
      next.configuration ?? {
        environmentId: '',
        modelId: '',
        timeoutMs: 310000,
        harnessTools: catalog.managedWorkspace ? [] : ['read_file', 'glob', 'list_files'],
      },
    );
    setSuite(JSON.stringify(next.suite ?? sampleSuite, null, 2));
    setStage(next.currentCandidateId ? 2 : 1);
    setRunId('');
    setPreview(null);
    setError('');
    setMessage('');
  }
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const post = (suffix: string, body: unknown) =>
    api<BundleTask>('/api/migration-bundles/' + task!.id + suffix, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  async function start(action: string, extra: Record<string, unknown> = {}) {
    const next = await post('/' + action, {
      key: crypto.randomUUID(),
      baseCandidateId: task!.currentCandidateId,
      ...extra,
    });
    setTask(next);
  }
  async function uploadZip(file: File) {
    if (!name.trim() || !goal.trim() || !target.trim())
      throw new Error('请先填写任务名称、业务目标和目标环境');
    const query = new URLSearchParams({ name, goal, target });
    select(
      await api<BundleTask>('/api/migration-bundles/upload?' + query, {
        method: 'POST',
        body: file,
        headers: { 'content-type': 'application/zip' },
      }),
    );
    await list();
  }
  async function uploadMembers(files: File[]) {
    const ids: string[] = [];
    const results = await importMigrationFiles(files, async (bytes) => {
      const asset = await api<{ assetId: string }>('/api/migrations/upload', {
        method: 'POST',
        body: new Blob([bytes as BlobPart]),
        headers: { 'content-type': 'application/zip' },
      });
      ids.push(asset.assetId);
    });
    setSelected((old) => [...new Set([...old, ...ids])]);
    await onChanged();
    const failed = results.filter((r) => r.status === 'FAILED');
    setMessage(
      '已导入 ' +
        ids.length +
        ' 个 Skill；请选择成员并创建同一迁移任务。' +
        failed.map((r) => r.name + '：' + r.error).join('；'),
    );
  }
  async function showFile(path: string) {
    const url = '/api/migration-bundles/' + task!.id + '/file?path=' + encodeURIComponent(path);
    const beforeId = current?.parentId;
    const before = await api<{ content: string }>(
      url + (beforeId ? '&candidateId=' + encodeURIComponent(beforeId) : ''),
    ).catch(() => ({ content: '（该版本没有此文件，或内容为二进制）' }));
    const after = await api<{ content: string }>(
      url + '&candidateId=' + encodeURIComponent(current!.id),
    ).catch(() => ({ content: '（文件已移除，或内容为二进制）' }));
    setPreview({ path, before: before.content, after: after.content });
  }
  const disabled = busy || Boolean(active);
  return (
    <section className="migration-panel bundle-panel">
      <header className="bundle-heading">
        <div>
          <h2>{task?.name ?? '多 Skill 整体迁移'}</h2>
          <p>
            {task
              ? task.source.members.length +
                ' 个 Skill · 同一个 Agent 工作区 · ' +
                (current ? '整组候选 r' + task.candidates.length : '尚未生成候选')
              : '导入整组 Skill，整体改造并在本任务内联合验收。'}
          </p>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              setTask(null);
              setStage(0);
              await list();
            })
          }
        >
          任务列表 / 新建
        </button>
      </header>
      {error && (
        <p role="alert" className="bundle-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {task && (
        <nav aria-label="整组迁移步骤">
          {stages.map((label, index) => (
            <button
              key={label}
              className={stage === index ? 'active' : ''}
              aria-current={stage === index ? 'step' : undefined}
              onClick={() => setStage(index)}
            >
              <span>{index + 1}</span> {label}
            </button>
          ))}
        </nav>
      )}
      {active && (
        <div className="bundle-notice" role="status">
          {active.message}
          <button
            className="button secondary"
            onClick={() => void act(async () => setTask(await post('/cancel', {})))}
          >
            取消当前操作
          </button>
        </div>
      )}
      {!active && latestAttempt?.error && (
        <p className="bundle-notice">
          {statusLabels[latestAttempt.status]}：{latestAttempt.error}
        </p>
      )}
      {!task && (
        <>
          <section className="stage-section">
            <h3>新建整体迁移任务</h3>
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
                  placeholder="这组 Skill 需要共同完成什么任务？"
                />
              </label>
            </div>
            <div className="bundle-actions">
              <button className="button secondary" disabled={busy} onClick={() => zipInput.current?.click()}>
                导入整组工程 ZIP
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => filesInput.current?.click()}
              >
                导入多个 Skill 文件
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
            <h4>从已有资产选择成员</h4>
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
              disabled={busy || !selected.length || !name.trim() || !goal.trim() || !target.trim()}
              onClick={() =>
                void act(async () => {
                  select(
                    await api<BundleTask>('/api/migration-bundles', {
                      method: 'POST',
                      body: JSON.stringify({ name, goal, target, sourceAssetIds: selected }),
                    }),
                  );
                  await list();
                })
              }
            >
              创建整体迁移任务
            </button>
          </section>
          <section className="stage-section">
            <h3>已有整体迁移任务</h3>
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
                      void act(async () => select(await api<BundleTask>('/api/migration-bundles/' + item.id)))
                    }
                  >
                    继续处理
                  </button>
                </article>
              ))
            ) : (
              <p>尚未创建整体迁移任务。</p>
            )}
          </section>
        </>
      )}
      {task && stage === 0 && (
        <section className="stage-section">
          <h3>整组输入</h3>
          <p>{task.goal}</p>
          <p>目标：{task.target}</p>
          {task.source.members.map((member) => (
            <div className="bundle-task-row" key={member.id}>
              <strong>{member.skillId}</strong>
              <code>{member.skillFile}</code>
            </div>
          ))}
          <button className="button primary" onClick={() => setStage(1)}>
            诊断与迁移方案
          </button>
        </section>
      )}
      {task && stage === 1 && (
        <section className="stage-section">
          <h3>整体诊断与迁移方案</h3>
          <p>Agent 会查看全部 Skill、共享源码和已有调度配置，识别需要共同调整的内容。</p>
          {task.analysis && (
            <>
              <p className="bundle-summary">{task.analysis.summary}</p>
              {task.analysis.changes.map((change, index) => (
                <div className="bundle-task-row" key={index}>
                  <div>
                    <p>{change.reason}</p>
                    <small>{change.paths.join('、')}</small>
                  </div>
                </div>
              ))}
              {task.analysis.missing.length > 0 && (
                <p className="bundle-error">
                  待补充：{task.analysis.missing.join('；')}。请补齐源工程后重新导入。
                </p>
              )}
            </>
          )}
          <div className="bundle-actions">
            <button
              className="button primary"
              disabled={disabled}
              onClick={() => void act(() => start('analysis'))}
            >
              {task.analysis ? '重新分析整组' : '分析整组 Skill'}
            </button>
            {task.analysis && !task.analysis.missing.length && (
              <button className="button secondary" onClick={() => setStage(2)}>
                查看与执行改造
              </button>
            )}
          </div>
        </section>
      )}
      {task && stage === 2 && (
        <section className="stage-section">
          <h3>整组迁移结果</h3>
          <p>同一个 Agent 可以跨 Skill 修改，未变化的成员随整组候选保留。</p>
          {current && (
            <>
              <p className="bundle-summary">{current.summary}</p>
              <div className="bundle-task-row">
                <span>
                  {current.members.length} 个成员 · {current.diff.length} 个文件变化
                </span>
                <span>静态清单检查通过；实际效果由联合验收确认</span>
              </div>
              {current.diff.map((file) => (
                <div className="bundle-task-row" key={file.path}>
                  <span>
                    {file.kind === 'ADDED' ? '新增' : file.kind === 'REMOVED' ? '移除' : '修改'} ·{' '}
                    <code>{file.path}</code>
                  </span>
                  <button className="button secondary" onClick={() => void act(() => showFile(file.path))}>
                    查看差异
                  </button>
                </div>
              ))}
              {preview && (
                <details open>
                  <summary>{preview.path}</summary>
                  <div className="bundle-file-diff">
                    <pre>{preview.before}</pre>
                    <pre>{preview.after}</pre>
                  </div>
                </details>
              )}
              <details>
                <summary>候选历史（{task.candidates.length}）</summary>
                {task.candidates.map((c, index) => (
                  <p key={c.id}>
                    r{index + 1} · {c.summary} · {c.createdAt}
                  </p>
                ))}
              </details>
            </>
          )}
          <div className="bundle-actions">
            <button
              className="button primary"
              disabled={disabled || !task.analysis || Boolean(task.analysis.missing.length)}
              onClick={() => void act(() => start('generate'))}
            >
              {current ? '继续整体改造' : '生成整组迁移结果'}
            </button>
            {current && (
              <button className="button secondary" onClick={() => setStage(3)}>
                Runtime 适配与登记
              </button>
            )}
          </div>
        </section>
      )}
      {task && stage === 3 && (
        <section className="stage-section">
          <h3>整组运行配置</h3>
          <div className="bundle-fields">
            <label>
              已登记执行环境
              <select
                aria-label="已登记执行环境"
                value={config.environmentId}
                onChange={(e) => {
                  const runtime = catalog.executionRuntimes.find((r) => r.runtimeId === e.target.value);
                  setConfig((c) => ({
                    ...c,
                    environmentId: e.target.value,
                    modelId: runtime?.defaultModelId ?? '',
                  }));
                }}
              >
                <option value="">选择支持多 Skill 的环境</option>
                {catalog.executionRuntimes.map((r) => (
                  <option key={r.runtimeId} value={r.runtimeId}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              执行模型
              <select
                aria-label="执行模型"
                value={config.modelId}
                onChange={(e) => setConfig((c) => ({ ...c, modelId: e.target.value }))}
              >
                <option value="">选择模型</option>
                {runtime?.models.map((m) => (
                  <option key={m.modelId} value={m.modelId}>
                    {m.label ?? m.modelId}
                  </option>
                ))}
              </select>
            </label>
            <label>
              入口指令文件（可选）
              <input
                value={config.entryInstructionsFile ?? ''}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, entryInstructionsFile: e.target.value || undefined }))
                }
                placeholder="现有 Agent 业务指令的相对路径"
              />
            </label>
            <label>
              每个案例超时（秒）
              <input
                type="number"
                min={10}
                max={900}
                value={config.timeoutMs / 1000}
                onChange={(e) => setConfig((c) => ({ ...c, timeoutMs: Number(e.target.value) * 1000 }))}
              />
            </label>
          </div>
          {!catalog.managedWorkspace && (
            <label className="bundle-checkbox">
              <input
                type="checkbox"
                checked={config.harnessTools.includes('bash')}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    harnessTools: e.target.checked
                      ? ['read_file', 'glob', 'list_files', 'bash']
                      : ['read_file', 'glob', 'list_files'],
                  }))
                }
              />
              允许执行 Skill 包中的脚本（目标环境需支持）
            </label>
          )}
          <p>
            已有的共享外部 MCP 通过执行环境绑定；包内 MCP
            按迁移产物启动。入口指令仅支持文本业务指令，不执行工作流配置。
          </p>
          <button
            className="button primary"
            disabled={disabled || !config.environmentId || !config.modelId}
            onClick={() =>
              void act(async () => {
                setTask(
                  await api<BundleTask>('/api/migration-bundles/' + task.id + '/configuration', {
                    method: 'PUT',
                    body: JSON.stringify(config),
                  }),
                );
                setStage(4);
              })
            }
          >
            保存运行配置
          </button>
        </section>
      )}
      {task && stage === 4 && (
        <section className="stage-section">
          <h3>验证整组能否运行</h3>
          <p>
            检查 Runtime 是否支持真实多 Skill 装载、共享服务以及整组容量。实际启动和工具调用在联合验收时验证。
          </p>
          <div className="bundle-actions">
            <button
              className="button primary"
              disabled={disabled || !current || !task.configuration}
              onClick={() =>
                void act(async () => {
                  const result = await api<{ message: string }>(
                    '/api/migration-bundles/' + task.id + '/runtime-check',
                    { method: 'POST', body: '{}' },
                  );
                  setMessage(result.message);
                })
              }
            >
              检查运行能力
            </button>
            <button
              className="button secondary"
              disabled={!current || !task.configuration}
              onClick={() => setStage(5)}
            >
              进入联合验收
            </button>
          </div>
        </section>
      )}
      {task && stage === 5 && (
        <section className="stage-section">
          <h3>多 Skill 联合验收</h3>
          <p>自动使用当前整组候选。开发回归反馈可用于整体修复；独立留出案例不反馈给迁移 Agent。</p>
          <label>
            验收测试集 JSON
            <textarea
              aria-label="验收测试集 JSON"
              className="bundle-suite"
              value={suite}
              onChange={(e) => setSuite(e.target.value)}
              spellCheck={false}
            />
          </label>
          <div className="bundle-actions">
            <button
              className="button secondary"
              disabled={disabled}
              onClick={() =>
                void act(async () => {
                  setTask(
                    await api<BundleTask>('/api/migration-bundles/' + task.id + '/suite', {
                      method: 'PUT',
                      body: JSON.stringify(JSON.parse(suite)),
                    }),
                  );
                  setMessage('验收测试集已保存');
                })
              }
            >
              保存测试集
            </button>
            <button
              className="button primary"
              disabled={disabled || !current || !task.suite || !task.configuration}
              onClick={() =>
                void act(async () => {
                  setRunId('');
                  await start('acceptance', { phase: 'development' });
                })
              }
            >
              开始整组联合验收
            </button>
            {Boolean(task.suite?.holdoutCases?.length) && (
              <button
                className="button secondary"
                disabled={disabled || !current || !task.configuration}
                onClick={() =>
                  void act(async () => {
                    setRunId('');
                    await start('acceptance', { phase: 'holdout' });
                  })
                }
              >
                执行独立留出验收
              </button>
            )}
          </div>
          {task.runs.length > 0 && (
            <label>
              运行记录
              <select aria-label="运行记录" value={run?.id ?? ''} onChange={(e) => setRunId(e.target.value)}>
                {[...task.runs].reverse().map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.createdAt} · {r.phase === 'holdout' ? '留出' : '开发'} · {statusLabels[r.status]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {run && (
            <BundleRunView
              run={run}
              currentCandidateId={task.currentCandidateId}
              configurationMatches={
                JSON.stringify(run.configuration) === JSON.stringify(task.configuration) &&
                JSON.stringify(run.suite) === JSON.stringify(task.suite)
              }
            />
          )}
          {run &&
            run.candidateId === task.currentCandidateId &&
            ['FAILED', 'INCOMPLETE'].includes(run.status) &&
            run.phase === 'development' && (
              <button
                className="button primary"
                disabled={disabled}
                onClick={() =>
                  void act(async () => {
                    await start('repair', { runId: run.id });
                    setStage(2);
                  })
                }
              >
                让 Agent 查看整组并修复
              </button>
            )}
          <div className="bundle-actions">
            <button className="button secondary" disabled={!current} onClick={() => setStage(6)}>
              查看交付内容
            </button>
          </div>
        </section>
      )}
      {task && stage === 6 && (
        <section className="stage-section">
          <h3>整组交付</h3>
          <p>包含全部 Skill、共享文件、版本清单和有效验收报告。部署状态由目标环境另行确认。</p>
          <div className="bundle-actions">
            <button
              className="button secondary"
              disabled={!current || busy}
              onClick={() =>
                void act(() =>
                  downloadApi(
                    '/api/migration-bundles/' + task.id + '/export',
                    'migration-bundle-candidate.zip',
                  ),
                )
              }
            >
              下载候选源码
            </button>
            <button
              className="button primary"
              disabled={!current || busy || Boolean(active)}
              onClick={() =>
                void act(() =>
                  downloadApi(
                    '/api/migration-bundles/' + task.id + '/export?verified=true',
                    'migration-bundle-verified.zip',
                  ),
                )
              }
            >
              下载已验收交付包
            </button>
          </div>
          <p>已验收交付要求当前候选、运行配置和测试集与通过记录一致；有留出集时需留出验收通过。</p>
        </section>
      )}
    </section>
  );
}
function BundleRunView({
  run,
  currentCandidateId,
  configurationMatches,
}: {
  run: BundleRun;
  currentCandidateId: string | null;
  configurationMatches: boolean;
}) {
  return (
    <div className="bundle-run">
      <h4>
        {statusLabels[run.status]} · {run.cases.filter((c) => c.passed).length}/
        {run.phase === 'holdout' ? run.suite.holdoutCases?.length : run.suite.cases.length} 个案例通过
      </h4>
      {run.candidateId !== currentCandidateId && (
        <p className="bundle-notice">历史候选的验收记录；当前候选需重新验收。</p>
      )}
      {!configurationMatches && (
        <p className="bundle-notice">运行配置或测试集已变化；此记录不能作为当前交付的验收结论。</p>
      )}
      {run.cases.map((c) => (
        <details key={c.id}>
          <summary>
            {c.id} · {c.passed ? '通过' : '未通过'}
          </summary>
          <p>{c.reason}</p>
          <h5>实际输出</h5>
          <pre>{c.evidence?.output ?? '未获得执行结果'}</pre>
          <h5>装载成员</h5>
          <p>{c.evidence?.loadedSkills.map((s) => s.skillId + ' · ' + s.version).join('、') ?? '未采集'}</p>
          <p>Skill 激活证据以工具记录为准，装载不表示每个成员均被调用。</p>
          <details>
            <summary>工具与运行证据</summary>
            <pre>{JSON.stringify(c.evidence, null, 2)}</pre>
          </details>
        </details>
      ))}
    </div>
  );
}
