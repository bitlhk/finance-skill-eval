import { useState } from 'react';
import { downloadApi } from '../../api-path';
import type { BundleTask } from '../../../../src/migration/tasks/domain/task-model';
import type { MigrationWorkbench } from './useMigrationWorkbench';

export function BuilderPanel({ state }: { state: MigrationWorkbench }) {
  const { task, current, config, setConfig, setTask, api, act, disabled, catalog, refreshCatalog, setMessage } = state;
  const [runtimeType, setRuntimeType] = useState('openjiuwen');
  const [os,setOs]=useState('linux'), [arch,setArch]=useState('x64');
  const [trust, setTrust] = useState('');
  const [capabilities, setCapabilities] = useState('[]');
  const [result, setResult] = useState('');
  if (!task) return null;
  const request = task.runtimeBuildRequests?.find(r => r.requirements.requestId === task.selectedRuntimeBuildRequestId);
  const status = task.builderStatus ?? 'NONE';
  const prefix = '/api/migration-tasks/' + task.id;
  const trustReferences = catalog.launcherTrustReferences ?? [];
  const selectedTrust = trust || trustReferences[0]?.reference || '';
  return <section className="stage-section" aria-label="Builder 接入">
    <h3>Builder 构建与交付</h3>
    <p>导出能力、运行平台与容量需求，交给 Builder 构建 Runtime 并回填交付。业务 Skill 在启动时装载。</p>
    <p role="status">绑定状态：{({ NONE: '使用已有环境', PENDING: '等待 Builder 交付', BOUND: 'Runtime 交付有效', STALE: 'Runtime 交付失效，需要重新接收' })[status]}</p>
    <div className="bundle-fields">
      <label>Builder 目标 Runtime<select aria-label="Builder 目标 Runtime" value={runtimeType} onChange={e => setRuntimeType(e.target.value)}>
        <option value="openjiuwen">OpenJiuwen</option><option value="agentscope">AgentScope Java</option><option value="ea">EA</option><option value="generic_http">通用 Runtime</option>
      </select></label>
      <label>运行平台<select aria-label="Builder 运行平台" value={os} onChange={e=>setOs(e.target.value)}><option value="linux">Linux</option><option value="windows">Windows</option><option value="darwin">macOS</option></select></label>
      <label>处理器架构<select aria-label="Builder 处理器架构" value={arch} onChange={e=>setArch(e.target.value)}><option value="x64">x64</option><option value="arm64">ARM64</option></select></label>
      <p>执行隔离：可信本机进程。运行脚本需要受信工作区。</p>
    </div>
    <p>需求只包含 Runtime 构建条件。模型、入口指令、Skill 和业务工具配置保留在 Eval，用于启动实例；修改这些输入后需要重新验收。</p>
    <details><summary>原生能力合同（可选）</summary>
      <p>填写 Builder 协议的 requiredCapabilities 数组；已明确依赖原生能力时需提供完整合同。容量与共享服务所需的执行能力会自动写入需求。</p>
      <textarea aria-label="Builder 原生能力合同" rows={6} value={capabilities} onChange={e => setCapabilities(e.target.value)} />
    </details>
    <div className="bundle-actions">
      <button className="button secondary" disabled={disabled || !current} onClick={() => void act(async () => {
        const { environmentId: _, modelId, ...settings } = config;
        const next = await api<BundleTask>(prefix + '/runtime-build-requests', { method: 'POST', body: JSON.stringify({ ...settings, ...(modelId ? { modelId } : {}),
          baseCandidateId: current!.id, runtimeType, platform:{os,arch,isolation:'trusted_local_process'}, requiredCapabilities: JSON.parse(capabilities) }) });
        setTask(next); setResult('');
        await downloadApi(prefix + '/runtime-requirements.yaml?requestId=' + next.selectedRuntimeBuildRequestId, 'runtime-build-requirements.yaml');
      })}>生成并下载 Builder 需求</button>
      {request && <button className="button secondary" disabled={disabled} onClick={() => void act(() => downloadApi(prefix + '/runtime-requirements.yaml?requestId=' + request.requirements.requestId, 'runtime-build-requirements.yaml'))}>重新下载当前需求</button>}
    </div>
    {request && <>
      <p>需求：<code>{request.requirements.requestId}</code></p><p>容量要求：{request.requirements.executionRequirements.limits.maxSkills} 个 Skill</p>
      <label>交付信任引用<select aria-label="Builder 交付信任引用" value={selectedTrust} onChange={e => setTrust(e.target.value)}>
        {!trustReferences.length && <option value="">服务端未配置交付准入</option>}
        {trustReferences.map(t => <option key={t.reference} value={t.reference}>{t.label}</option>)}
      </select></label>
      {!trustReferences.length && <p>请在 API 服务配置 FINANCE_EVAL_LAUNCHER_TRUST_JSON 后重启服务。</p>}
      <label>导入 Builder Result JSON<input aria-label="导入 Builder Result JSON" type="file" accept=".json,application/json" disabled={disabled} onChange={e => {
        const file = e.target.files?.[0]; if (file) void act(async () => { if (file.size > 1024 * 1024) throw new Error('Builder Result 不得超过 1 MB'); setResult(await file.text()); });
      }} /></label>
      <label>Builder Result<textarea aria-label="Builder Result" rows={7} value={result} onChange={e => setResult(e.target.value)} /></label>
      <p>接收时用平台验证 Skill 检查 Runtime 的启动、真实工具执行与释放。当前业务 Skill 另行进行启动检查和联合验收。</p>
      <button className="button primary" disabled={disabled || !result.trim() || !selectedTrust || status === 'STALE'} onClick={() => void act(async () => {
        setMessage('正在验证 Runtime 交付和资源生命周期…');
        const next = await api<BundleTask>(prefix + '/runtime-deliveries', { method: 'POST', body: JSON.stringify({ result: JSON.parse(result), trustReference: selectedTrust }) });
        setTask(next); setConfig(next.configuration!); await refreshCatalog();
        setMessage('Builder 交付已绑定，接下来进行启动检查和联合验收。');
      })}>验证并绑定 Builder 交付</button>
      <button className="button secondary" disabled={disabled} onClick={() => void act(async () => {
        setTask(await api<BundleTask>(prefix + '/runtime-builder-selection', { method: 'DELETE' }));
        setMessage('已切换为已有环境，Builder 历史保留；当前任务需按所选环境验收。');
      })}>切换为已有环境</button>
    </>}
    {!!task.runtimeBuildRequests?.length && <details><summary>Builder 需求历史（{task.runtimeBuildRequests.length}）</summary>
      {[...task.runtimeBuildRequests].reverse().map(r => <article key={r.requirements.requestId}><p>{r.createdAt} · <code>{r.requirements.requestId}</code></p><p>候选：<code>{r.candidateId}</code></p>
        <button className="button secondary" disabled={disabled} onClick={() => void act(() => downloadApi(prefix + '/runtime-requirements.yaml?requestId=' + r.requirements.requestId, 'runtime-build-requirements.yaml'))}>下载历史需求</button>
      </article>)}
    </details>}
    {!!task.runtimeDeliveries?.length && <details><summary>Builder 交付历史（{task.runtimeDeliveries.length}）</summary>
      {[...task.runtimeDeliveries].reverse().map(b => <article key={b.id}><p>绑定：<code>{b.id}</code></p><p>Runtime 交付不绑定业务 Skill 版本</p><p>部署：<code>{b.launcher.deploymentId}</code></p><p>需求摘要：<code>{b.result.requirementsDigest}</code></p><p>交付摘要：<code>{b.result.resultDigest}</code></p></article>)}
    </details>}
  </section>;
}
