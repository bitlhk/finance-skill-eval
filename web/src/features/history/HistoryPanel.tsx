import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryDetail, HistoryKind, HistorySnapshot, HistorySummary } from '../../../../src/shared/contracts/history';
import { downloadApi } from '../../api-path';
import './history.css';

type Api = <T>(url: string, init?: RequestInit) => Promise<T>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const entries = (value: unknown) => Array.isArray(value) ? value.map(object) : [];
const labels: Record<string, string> = { PASSED: '当时通过', FAILED: '当时未通过', COMPLETED: '当时完成', RUNNING: '当时执行中（不会恢复）', INCOMPLETE: '未完成', CANCELLED: '已取消', INTERRUPTED: '已中断', ANALYZE: '分析', GENERATE: '生成', ACCEPT: '验收', REPAIR: '修复' };
const label = (value: unknown) => labels[text(value)] ?? text(value);
function JsonDetails({ title, value }: { title: string; value: unknown }) {
  return value == null ? null : <details><summary>{title}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

export function HistoryPanel({ kind, api }: { kind: HistoryKind; api: Api }) {
  const [items, setItems] = useState<HistorySummary[]>([]);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [snapshot, setSnapshot] = useState<HistorySnapshot | null>(null);
  const [preview, setPreview] = useState<{path: string; content: string} | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try { setItems(await api<HistorySummary[]>('/api/history/' + kind)); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  }, [api, kind]);
  useEffect(() => { void reload(); return () => { request.current++; }; }, [reload]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const select = async (item: HistorySummary) => {
    const serial = ++request.current;
    setSnapshot(null); setPreview(null); setDetail(null);
    const next = await api<HistoryDetail>(`/api/history/${item.origin}/${item.id}`);
    if (serial === request.current) setDetail(next);
  };
  const prefix = detail ? `/api/history/${detail.origin}/${detail.id}` : '';
  const record = object(detail?.record);
  const analysis = object(record.analysis);
  const members = entries(object(record.source).members);
  return <section className="history-panel" aria-label={kind === 'tasks' ? '历史迁移任务' : '历史环境登记'}>
    <header><div><h3>{kind === 'tasks' ? '历史迁移任务' : '历史环境登记'}（{items.length}）</h3>
      <p>旧版记录完整留档。可查看当时的内容和结果，不能在当前版本直接继续执行。</p></div>
      <button className="button secondary" disabled={busy || loading} onClick={() => void reload()}>刷新历史</button></header>
    {error && <p role="alert">{error}</p>}
    {loading ? <p role="status">正在读取历史记录…</p> : !items.length ? <p>没有旧版历史记录。</p> : null}
    {!detail && items.map(item => <article className="history-row" key={item.origin + ':' + item.id}>
      <div><strong>{item.name}</strong><span className="history-badge">只读历史</span><p>{item.createdAt ?? '创建时间未记录'}</p>
        <p>{item.reason}</p>{item.issue && <p>{item.issue}</p>}</div>
      <button className="button secondary" disabled={busy} onClick={() => void run(() => select(item))}>查看历史</button>
    </article>)}
    {detail && <article className="history-detail">
      <header><h4>{detail.name}</h4><button className="button secondary" disabled={busy} onClick={() => { request.current++; setDetail(null); setSnapshot(null); setPreview(null); setError(''); }}>返回历史列表</button></header>
      <div className="history-notice" role="note"><strong>只读历史 · 无法继续执行</strong><p>{detail.reason}</p><p>{detail.nextStep}</p>
        <p>历史中的“通过”仅表示当时记录的结果，不是当前版本的验收结论。</p></div>
      {detail.issue && <p role="alert">{detail.issue}</p>}
      {text(record.goal) && <><h4>业务目标</h4><p>{text(record.goal)}</p></>}
      {text(record.target) && <><h4>目标环境</h4><p>{text(record.target)}</p></>}
      {members.length > 0 && <><h4>原始 Skill</h4><ul>{members.map((member, i) => <li key={i}>{text(member.skillId) || text(member.id)} · {text(member.skillFile)}</li>)}</ul></>}
      {text(analysis.summary) && <><h4>历史分析</h4><p>{text(analysis.summary)}</p><JsonDetails title="分析详情" value={record.analysis}/></>}
      {entries(record.candidates).length > 0 && <section><h4>候选记录</h4>{entries(record.candidates).map((candidate, i) => <details key={i}>
        <summary>候选 {i + 1} · {text(candidate.createdAt)} · {text(candidate.summary)}</summary><pre>{JSON.stringify(candidate, null, 2)}</pre>
      </details>)}</section>}
      {entries(record.attempts).length > 0 && <section><h4>操作历史</h4>{entries(record.attempts).map((attempt, i) => <details key={i}>
        <summary>{label(attempt.kind)} · {label(attempt.status)} · {text(attempt.startedAt)}</summary>
        <p>{text(attempt.message)}</p>{text(attempt.error) && <p>{text(attempt.error)}</p>}<pre>{JSON.stringify(attempt, null, 2)}</pre>
      </details>)}</section>}
      {entries(record.runs).length > 0 && <section><h4>历史验收结果</h4>{entries(record.runs).map((run, i) => <details key={i}>
        <summary>验收 {i + 1} · {label(run.status)} · {text(run.createdAt)}</summary>
        {entries(run.cases).map((item, j) => <article key={j}><strong>{text(item.id)} · {item.passed === true ? '当时通过' : item.passed === false ? '当时未通过' : '未记录结论'}</strong><p>{text(item.reason)}</p><JsonDetails title="历史执行证据" value={item.evidence}/></article>)}
        <JsonDetails title="完整验收记录" value={run}/>
      </details>)}</section>}
      <JsonDetails title="历史环境与验收登记" value={kind === 'environments' ? record : record.configuration}/>
      {detail.snapshotIssue && <p role="status">{detail.snapshotIssue}</p>}
      {detail.snapshots.length > 0 && <section><h4>文件快照</h4><label>选择历史版本<select aria-label="选择历史版本" value={snapshot?.revision ?? ''} disabled={busy} onChange={event => {
        const revision = event.target.value; setSnapshot(null); setPreview(null);
        if (revision) void run(async () => setSnapshot(await api<HistorySnapshot>(prefix + '/snapshot?revision=' + encodeURIComponent(revision))));
      }}><option value="">请选择版本</option>{detail.snapshots.map(item => <option key={item.revision} value={item.revision}>{item.label}</option>)}</select></label>
        {snapshot && <><p>文件数：{snapshot.files.length}</p><div className="history-files">{snapshot.files.map(file => <button className="button secondary" disabled={busy} key={file} onClick={() => void run(async () => setPreview(await api(prefix + '/file?' + new URLSearchParams({revision:snapshot.revision,path:file}))))}>{file}</button>)}</div></>}
        {preview && <div><h4>{preview.path}</h4><pre aria-label="历史文件内容">{preview.content}</pre></div>}
      </section>}
      <details><summary>原始记录与版本信息</summary><p>记录：{detail.id} · 格式：{detail.schemaVersion} · 来源：{detail.origin}</p><pre>{JSON.stringify(detail.record, null, 2)}</pre></details>
      <button className="button secondary" disabled={busy} onClick={() => void run(() => downloadApi(prefix + '/archive', 'historical-record.zip'))}>下载历史留档</button>
      <p>留档包含原始记录和可读取的快照，不是当前版本已验收的交付包。</p>
    </article>}
  </section>;
}
