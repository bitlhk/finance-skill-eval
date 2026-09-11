import { useEffect, useState } from "react";
import { Check, GitCompareArrows, LoaderCircle, RotateCw, Sparkles, X } from "lucide-react";
import type { EvaluationJob, SkillAsset } from "./types";
import { ResultCharts } from "./ResultCharts";
import { MarkdownContent } from "./MarkdownContent";
import { authHeaders, apiPath } from './api-path';

type Optimization = {
  optimizationId: string; sourceJobId: string; status: string; modelId: string;
  summary: string; findings: string[]; changes: Array<{ path: string; before: string; after: string; reason: string }>;
  candidate: SkillAsset | null; rerunJobId: string | null; error: string | null;
  stages: Array<{ stage: string; at: string }>;
};
const STAGES = [{ id: "diagnosing", label: "专业诊断与修改" }, { id: "validating", label: "生成候选" }, { id: "reevaluating", label: "同条件复测与留出验证" }, { id: "review", label: "人工选择" }];
async function request<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(apiPath(url), { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...authHeaders() }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json(); if (!r.ok) throw new Error(data.message || "请求失败"); return data;
}
export function OptimizationPanel({ job, migrationId, onCandidate }: { job: EvaluationJob; migrationId?:string; onCandidate?:()=>void }) {
  const [item, setItem] = useState<Optimization | null>(null);
  const [rerun, setRerun] = useState<EvaluationJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setItem(null); setRerun(null); setError("");
    let disposed = false;
    void request<Optimization | null>(`/api/runs/${job.jobId}/optimization`).then(async next => {
      if (!next) return;
      const run = next.rerunJobId ? await request<EvaluationJob>(`/api/runs/${next.rerunJobId}`) : null;
      if (!disposed) { setItem(next); setRerun(run); }
    }).catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, [job.jobId]);
  useEffect(() => {
    if (!item || ["adopted", "retained", "failed", "cancelled"].includes(item.status)) return;
    let disposed = false, inFlight = false;
    const refresh = async () => {
      if (inFlight) return; inFlight = true;
      try {
        const next = await request<Optimization>(`/api/optimizations/${item.optimizationId}`);
        const run = next.rerunJobId ? await request<EvaluationJob>(`/api/runs/${next.rerunJobId}`) : null;
        if (!disposed) { setItem(next); setRerun(run); }
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : String(e)); }
      finally { inFlight = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [item?.optimizationId, item?.status]);
  const start = async () => {
    setBusy(true); setError("");
    try { const next = await request<Optimization>(migrationId?`/api/migrations/${migrationId}/optimize`:`/api/runs/${job.jobId}/optimize`, migrationId?{jobId:job.jobId}:{}); setItem(next); localStorage.setItem(`finance-optimization:${job.jobId}`, next.optimizationId); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const decide = async (decision: string) => {
    setBusy(true);
    try {
      if (migrationId && decision==='adopt') {
        await request(`/api/migrations/${migrationId}/optimized-candidate`,{optimizationId:item!.optimizationId});
        onCandidate?.();
      }
      setItem(await request<Optimization>(`/api/optimizations/${item!.optimizationId}/decision`, { decision })); window.dispatchEvent(new Event("finance-eval-assets-changed"));
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const active = item && ["diagnosing", "validating", "reevaluating"].includes(item.status);
  const changedReferences = item?.changes.filter(c => c.path !== "SKILL.md").map(c => c.path) ?? [];
  const unusedReferences = changedReferences.filter(p => !rerun?.evidence.some(e => e.side === "right" && e.metadata?.referenceFilesRead?.[p]));
  const reevaluate = async () => {
    setBusy(true); setError("");
    try { setItem(await request<Optimization>(`/api/optimizations/${item!.optimizationId}/reevaluate`, {})); setRerun(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return <section className="optimization-panel">
    <header><div><h3><Sparkles size={18} /> Skill 改进候选</h3><span>{item ? `${item.modelId} · 独立优化会话` : "基于本轮专业评价，生成一轮候选并复测"}</span></div>
      {!item ? <button className="button primary" disabled={busy} onClick={start}>{busy ? <LoaderCircle className="spin" size={16} /> : <GitCompareArrows size={16} />}生成候选并复测</button> : active ? <button className="button secondary" disabled={busy} onClick={() => decide("cancel")}><X size={16} />取消优化</button> : null}
    </header>
    {error || item?.error ? <div className="run-error">{error || item?.error}</div> : null}
    {item ? <>
      <ol className="optimization-stages">{STAGES.map((s, index) => {
        const reached = active ? index < STAGES.findIndex(t => t.id === item.status) : item.stages.some(t => t.stage === s.id); const running = active && item.status === s.id;
        return <li key={s.id} className={running ? "active" : reached ? "done" : ""}>{running ? <LoaderCircle className="spin" size={16} /> : reached ? <Check size={16} /> : <span className="stage-dot" />}<span>{s.label}</span></li>;
      })}</ol>
      {item.summary ? <MarkdownContent compact content={item.summary} /> : null}
      {item.findings.length ? <ul>{item.findings.map((f,i) => <li key={i}>{f}</li>)}</ul> : null}
      {item.candidate ? <p className="mono">候选 {item.candidate.version} · SHA {item.candidate.artifactSha256.slice(0,16)}</p> : null}
      {item.changes.map(c => <details className="candidate-diff" key={c.path}><summary>{c.path} · {c.reason}</summary><div className="answer-grid"><article><span>修改前</span><pre>{c.before}</pre></article><article><span>候选版本</span><pre>{c.after}</pre></article></div></details>)}
      {rerun ? <div className="candidate-validation"><strong>{rerun.report?.summary.headline ?? rerun.stageLabel}</strong><p>{rerun.progress.completedRuns}/{rerun.progress.totalRuns} 次执行 · 原版 A / 候选 B</p>
        {rerun.report && unusedReferences.length > 0 ? <div className="info-banner">以下候选文件未记录到读取证据，尚不能确认修改效果：{unusedReferences.join("、")}</div> : null}
        {rerun.report ? <><ResultCharts report={rerun.report} />{rerun.report.cases.map(c => <details key={c.caseId}><summary>{c.name} · {c.judge?.winner === "right" ? "候选更优" : c.judge?.winner === "left" ? "原版更优" : c.judge ? "持平" : "未评分"}</summary><MarkdownContent content={c.judge?.summary ?? c.judgeError ?? ""} /><div className="answer-grid"><article><MarkdownContent content={c.left.output} /></article><article><MarkdownContent content={c.right.output} /></article></div></details>)}</> : null}
      </div> : null}
      {item.candidate && ["review", "failed"].includes(item.status) ? <button className="button secondary" disabled={busy} onClick={reevaluate}><RotateCw size={16} />重新复测当前候选</button> : null}
      {item.status === "review" ? <div className="optimization-actions"><button className="button primary" disabled={busy} onClick={() => decide("adopt")}><Check size={16} />保留为可用候选</button><button className="button secondary" disabled={busy} onClick={() => decide("retain")}>沿用原版</button><span>仅保存本地选择，不自动发布或替换现有 Skill。</span></div> : null}
      {item.status === "adopted" || item.status === "retained" ? <div className="info-banner">{item.status === "adopted" ? "已保留候选，可在版本选择中继续评测。原版未改变。" : "已选择沿用原版，候选和复测证据仍保留。"}</div> : null}
    </> : null}
  </section>;
}
