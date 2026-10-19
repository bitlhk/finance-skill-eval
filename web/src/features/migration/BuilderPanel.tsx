import { useState } from 'react';
import { downloadApi } from '../../api-path';
import type { BundleTask } from '../../../../src/migration/tasks/domain/task-model';
import type { MigrationWorkbench } from './useMigrationWorkbench';

export function BuilderPanel({ state }: { state: MigrationWorkbench }) {
  const { task, current, config, setConfig, setTask, api, act, disabled, catalog, refreshCatalog, setMessage } = state;
  const [runtimeType, setRuntimeType] = useState('openjiuwen');
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
    <p>需要适配目标 Runtime 时，导出所选 Skill 的需求与可选依赖，交给外部 Builder 构建部署，再回填交付结果。</p>
    <p role="status">绑定状态：{({ NONE: '使用已有环境', PENDING: '等待 Builder 交付', BOUND: '已绑定当前候选与配置', STALE: '绑定已失效，请重新导出需求' })[status]}</p>
    <div className="bundle-fields">
      <label>Builder 目标 Runtime<select aria-label="Builder 目标 Runtime" value={runtimeType} onChange={e => setRuntimeType(e.target.value)}>
        <option value="openjiuwen">OpenJiuwen</option><option value="agentscope">AgentScope Java</option><option value="ea">EA</option><option value="generic_http">通用 Runtime</option>
      </select></label>
    </div>
    <p>需求使用上方的模型（未选时使用交付环境默认模型）、入口指令、超时与脚本权限。生成需求后请保持配置不变；接收交付会自动选择新环境。</p>
    <details><summary>原生能力合同（可选）</summary>
      <p>填写 Builder 协议的 requiredCapabilities 数组；已明确依赖原生能力时需提供完整合同。整组装载、共享服务和运行设置会自动写入需求。</p>
      <textarea aria-label="Builder 原生能力合同" rows={6} value={capabilities} onChange={e => setCapabilities(e.target.value)} />
    </details>
    <div className="bundle-actions">
      <button className="button secondary" disabled={disabled || !current} onClick={() => void act(async () => {
        const { environmentId: _, modelId, ...settings } = config;
        const next = await api<BundleTask>(prefix + '/runtime-build-requests', { method: 'POST', body: JSON.stringify({ ...settings, ...(modelId ? { modelId } : {}),
          baseCandidateId: current!.id, runtimeType, requiredCapabilities: JSON.parse(capabilities) }) });
        setTask(next); setResult('');
        await downloadApi(prefix + '/runtime-requirements.yaml?requestId=' + next.selectedRuntimeBuildRequestId, 'runtime-build-requirements.yaml');
      })}>生成并下载 Builder 需求</button>
      <button className="button secondary" disabled={disabled || !request} onClick={() => void act(() => downloadApi(prefix + '/runtime-build-requests/' + request!.requirements.requestId + '/skills.json', 'builder-skills.json'))}>下载绑定的 Skill 与依赖</button>
      {request && <button className="button secondary" disabled={disabled} onClick={() => void act(() => downloadApi(prefix + '/runtime-requirements.yaml?requestId=' + request.requirements.requestId, 'runtime-build-requirements.yaml'))}>重新下载当前需求</button>}
    </div>
    {request && <>
      <p>需求：<code>{request.requirements.requestId}</code></p><p>候选：<code>{request.candidateId}</code></p>
      <label>交付信任引用<select aria-label="Builder 交付信任引用" value={selectedTrust} onChange={e => setTrust(e.target.value)}>
        {!trustReferences.length && <option value="">服务端未配置交付准入</option>}
        {trustReferences.map(t => <option key={t.reference} value={t.reference}>{t.label}</option>)}
      </select></label>
      {!trustReferences.length && <p>请在 API 服务配置 FINANCE_EVAL_LAUNCHER_TRUST_JSON 后重启服务。</p>}
      <label>导入 Builder Result JSON<input aria-label="导入 Builder Result JSON" type="file" accept=".json,application/json" disabled={disabled} onChange={e => {
        const file = e.target.files?.[0]; if (file) void act(async () => { if (file.size > 1024 * 1024) throw new Error('Builder Result 不得超过 1 MB'); setResult(await file.text()); });
      }} /></label>
      <label>Builder Result<textarea aria-label="Builder Result" rows={7} value={result} onChange={e => setResult(e.target.value)} /></label>
      <p>接收时会真实装载全部成员、执行连通检查并删除实例；检查通过后仍需完成业务验收。</p>
      <button className="button primary" disabled={disabled || !result.trim() || !selectedTrust || status === 'STALE'} onClick={() => void act(async () => {
        setMessage('正在验证 Builder 交付并执行整组生命周期检查…');
        const next = await api<BundleTask>(prefix + '/runtime-deliveries', { method: 'POST', body: JSON.stringify({ result: JSON.parse(result), trustReference: selectedTrust }) });
        setTask(next); setConfig(next.configuration!); await refreshCatalog();
        setMessage('Builder 交付已绑定，接下来进行任务验收。');
      })}>验证并绑定 Builder 交付</button>
      <button className="button secondary" disabled={disabled} onClick={() => void act(async () => {
        setTask(await api<BundleTask>(prefix + '/runtime-builder-selection', { method: 'DELETE' }));
        setMessage('已切换为已有环境，Builder 历史保留；当前任务需按所选环境验收。');
      })}>切换为已有环境</button>
    </>}
    {!!task.runtimeBuildRequests?.length && <details><summary>Builder 需求历史（{task.runtimeBuildRequests.length}）</summary>
      {[...task.runtimeBuildRequests].reverse().map(r => <article key={r.requirements.requestId}><p>{r.createdAt} · <code>{r.requirements.requestId}</code></p><p>候选：<code>{r.candidateId}</code></p>
        <button className="button secondary" disabled={disabled} onClick={() => void act(() => downloadApi(prefix + '/runtime-requirements.yaml?requestId=' + r.requirements.requestId, 'runtime-build-requirements.yaml'))}>下载历史需求</button>
        <button className="button secondary" disabled={disabled} onClick={() => void act(() => downloadApi(prefix + '/runtime-build-requests/' + r.requirements.requestId + '/skills.json', 'builder-skills.json'))}>下载历史 Skill 与依赖</button>
      </article>)}
    </details>}
    {!!task.runtimeDeliveries?.length && <details><summary>Builder 交付历史（{task.runtimeDeliveries.length}）</summary>
      {[...task.runtimeDeliveries].reverse().map(b => <article key={b.id}><p>绑定：<code>{b.id}</code></p><p>候选：<code>{b.candidateId}</code></p><p>部署：<code>{b.launcher.deploymentId}</code></p><p>需求摘要：<code>{b.result.requirementsDigest}</code></p><p>交付摘要：<code>{b.result.resultDigest}</code></p></article>)}
    </details>}
  </section>;
}
