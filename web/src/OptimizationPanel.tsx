import { useEffect, useState } from "react";
import { Check, GitCompareArrows, LoaderCircle, RotateCw, Sparkles, X } from "lucide-react";
import type { EvaluationJob } from "./types";
import type { Optimization } from "../../contracts/platform/responses";
import { ResultCharts } from "./ResultCharts";
import { MarkdownContent } from "./MarkdownContent";
import { authHeaders, apiPath } from './api-path';
import {OptimizationHistory,OptimizationSettings,defaultOptimizationGoal} from './OptimizationHistory';

const STAGES = [{ id: "diagnosing", label: "专业诊断" }, { id: "validating", label: "候选调整与检查" }, { id: "reevaluating", label: "开发集同条件复测" },{id:'reviewing',label:'独立效果审查'}, { id: "final_verifying", label: "最终留出集复核" }, { id: "review", label: "人工选择" }];
export function OptimizationQuestion({interaction,onAnswer,busy}:{interaction:unknown;onAnswer:(id:string,answers:Record<string,string>)=>void;busy:boolean}){
  const [answers,setAnswers]=useState<Record<string,string>>({});
  const [selections,setSelections]=useState<Record<string,string[]>>({});
  if(!interaction||typeof interaction!=='object')return <p>问题暂时无法显示，请检查任务记录。</p>;
  const record=interaction as {id?:unknown;interaction_id?:unknown;value?:unknown;questions?:unknown};
  const id=record.interaction_id??record.id;
  const value=record.value&&typeof record.value==='object'?record.value as {questions?:unknown}:record;
  type Question={question:string;multi_select?:boolean;options?:Array<{label:string;description?:string}>};
  const questions=Array.isArray(value.questions)?value.questions.filter((q):q is Question=>Boolean(q&&typeof q==='object'&&typeof q.question==='string')):[];
  if(typeof id!=='string'||!questions.length)return <p>问题暂时无法显示，请检查任务记录。</p>;
  return <div className="task-question"><h4>Agent 需要你的回答</h4>{questions.map(q=><div key={q.question} className="stage-section">
    <p><strong>{q.question}</strong></p>{Array.isArray(q.options)&&q.options.filter(option=>option&&typeof option.label==='string').map(option=><button
      key={option.label} type="button" className="button secondary" title={option.description} aria-pressed={(selections[q.question]??[]).includes(option.label)}
      onClick={()=>{const previous=selections[q.question]??[],selected=q.multi_select
        ?previous.includes(option.label)?previous.filter(label=>label!==option.label):[...previous,option.label]:[option.label];
        setSelections(current=>({...current,[q.question]:selected}));setAnswers(current=>({...current,[q.question]:selected.join('、')}));}}>{option.label}</button>)}
    <label>你的回答<textarea value={answers[q.question]??''} onChange={event=>{setAnswers(current=>({...current,[q.question]:event.target.value}));setSelections(current=>({...current,[q.question]:[]}));}}/></label></div>)}
    <button type="button" className="button primary" disabled={busy||questions.some(q=>!answers[q.question]?.trim())}
      onClick={()=>onAnswer(id,answers)}>回答并继续优化</button></div>;
}
async function request<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(apiPath(url), { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...authHeaders() }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json(); if (!r.ok) throw new Error(data.message || "请求失败"); return data;
}
export function OptimizationPanel({ job }: { job: EvaluationJob }) {
  const [goal,setGoal]=useState(defaultOptimizationGoal);
  const [item, setItem] = useState<Optimization | null>(null);
  const [rerun, setRerun] = useState<EvaluationJob | null>(null);
  const [holdoutRun,setHoldoutRun]=useState<EvaluationJob|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setItem(null); setRerun(null); setHoldoutRun(null); setError("");
    let disposed = false;
    void request<Optimization | null>(`/api/runs/${job.jobId}/optimization`).then(async next => {
      if (!next) return;
      const run = next.rerunJobId ? await request<EvaluationJob>(`/api/runs/${next.rerunJobId}`) : null;
      const holdout=next.holdoutJobId?await request<EvaluationJob>(`/api/runs/${next.holdoutJobId}`):null;
      if (!disposed) { setItem(next); setRerun(run);setHoldoutRun(holdout); }
    }).catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, [job.jobId]);
  useEffect(() => {
    if (!item || ["adopted", "retained", "failed", "cancelled", "interrupted"].includes(item.status)) return;
    let disposed = false, inFlight = false;
    const refresh = async () => {
      if (inFlight) return; inFlight = true;
      try {
        const next = await request<Optimization>(`/api/optimizations/${item.optimizationId}`);
        const run = next.rerunJobId ? await request<EvaluationJob>(`/api/runs/${next.rerunJobId}`) : null;
        const holdout=next.holdoutJobId?await request<EvaluationJob>(`/api/runs/${next.holdoutJobId}`):null;
        if (!disposed) { setItem(next); setRerun(run);setHoldoutRun(holdout); }
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : String(e)); }
      finally { inFlight = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [item?.optimizationId, item?.status]);
  const start = async () => {
    setBusy(true); setError("");
    try { const next = await request<Optimization>(`/api/runs/${job.jobId}/optimize`,goal); setItem(next); localStorage.setItem(`finance-optimization:${job.jobId}`, next.optimizationId); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const decide = async (decision: string) => {
    setBusy(true);
    try {
      setItem(await request<Optimization>(`/api/optimizations/${item!.optimizationId}/decision`, { decision })); window.dispatchEvent(new Event("finance-eval-assets-changed"));
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const active = item && ["diagnosing", "validating", "reevaluating", "reviewing", "final_verifying"].includes(item.status);
  const reviewAccepted=!item?.loop||item.effectReview?.status==='PRODUCED'&&item.effectReview.review.recommendation==='KEEP_CANDIDATE'&&item.reviewJobId===item.rerunJobId;
  const changedReferences = item?.changes.filter(c => /(^|\/)references\//.test(c.path)).map(c => c.path) ?? [];
  const skillRoot=item?.candidate?.skillFile.includes('/')?item.candidate.skillFile.slice(0,item.candidate.skillFile.lastIndexOf('/')+1):'';
  const unusedReferences = changedReferences.filter(p => !rerun?.evidence.some(e => e.side === "right" &&
    (e.metadata?.referenceFilesRead?.[p]||skillRoot&&p.startsWith(skillRoot)&&e.metadata?.referenceFilesRead?.[p.slice(skillRoot.length)])));
  const reevaluate = async () => {
    setBusy(true); setError("");
    try { setItem(await request<Optimization>(`/api/optimizations/${item!.optimizationId}/reevaluate`, {})); setRerun(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const finalVerify=async()=>{
    setBusy(true);setError('');
    try{setItem(await request<Optimization>(`/api/optimizations/${item!.optimizationId}/final-verify`,{}));setHoldoutRun(null)}
    catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  };
  const answer=async(interactionId:string,answers:Record<string,string>)=>{
    setBusy(true);setError('');
    try{setItem(await request<Optimization>(`/api/optimizations/${item!.optimizationId}/answer`,{interactionId,answers}));}
    catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  };
  const recover=async()=>{
    setBusy(true);setError('');
    try{setItem(await request<Optimization>(`/api/optimizations/${item!.optimizationId}/recover`,{}));}
    catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  };
  return <section className="optimization-panel">
    {!item&&<OptimizationSettings value={goal} onChange={setGoal} disabled={busy} cases={job.report?.cases.map(c=>({id:c.caseId}))}/>}
    <header><div><h3><Sparkles size={18} /> Skill 改进候选</h3><span>{item ? `${item.modelId} · 独立优化会话` : "基于开发集诊断、调整、复测并独立审查"}</span></div>
      {!item ? <button className="button primary" disabled={busy} onClick={start}>{busy ? <LoaderCircle className="spin" size={16} /> : <GitCompareArrows size={16} />}生成候选并复测</button> : active||item.status==='waiting' ? <button className="button secondary" disabled={busy} onClick={() => decide("cancel")}><X size={16} />取消优化</button> : null}
    </header>
    {error || item?.error ? <div className="run-error">{error || item?.error}</div> : null}
    {item ? <>
      {['failed','cancelled'].includes(item.status)&&<button className="button secondary" disabled={busy} onClick={()=>{setItem(null);setRerun(null);setHoldoutRun(null);setError('');}}>重新设置优化</button>}
      {(item.status==='interrupted'||(['failed','cancelled'].includes(item.status)&&!item.holdoutJobId&&item.loop?.rounds.at(-1)?.candidate))&&<button className="button secondary" disabled={busy} onClick={()=>void recover()}>核对并继续优化</button>}
      {item.loop&&<OptimizationHistory loop={item.loop}/>}
      {item.status==='waiting'&&item.engineeringInteraction?.interactions.map((interaction,index)=><OptimizationQuestion
        key={item.engineeringInteraction!.attemptId+'-'+index} interaction={interaction} busy={busy} onAnswer={(id,answers)=>void answer(id,answers)}/>)}
      {item.effectReview&&<p>当前复测的独立审查：{item.effectReview.status==='ABSTAINED'?item.effectReview.reason:item.effectReview.review.reason}</p>}
      <ol className="optimization-stages">{STAGES.map((s, index) => {
        const reached=s.id==='review'?item.holdoutVerified&&['adopted','retained'].includes(item.status):s.id==='final_verifying'?!!item.holdoutVerified:s.id==='reevaluating'?!!item.rerunJobId:item.stages.some(t=>t.stage===s.id)&&(!active||index<STAGES.findIndex(t=>t.id===item.status));
        const running=item.status===s.id&&(s.id!=='review'||!!item.holdoutVerified);
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
      {holdoutRun&&<div className="candidate-validation"><strong>最终留出集复核 · {holdoutRun.report?.summary.headline??holdoutRun.stageLabel}</strong><p>仅对当前候选运行一次；结果供最终选择，不进入编辑模型的反馈。</p>{holdoutRun.report&&<ResultCharts report={holdoutRun.report}/>}</div>}
      {item.candidate&&!item.holdoutJobId&&["review", "failed"].includes(item.status) ? <button className="button secondary" disabled={busy} onClick={reevaluate}><RotateCw size={16} />重新复测当前候选</button> : null}
      {item.status==='review'&&item.holdoutFingerprint&&!item.holdoutJobId&&<button className="button primary" disabled={busy||!reviewAccepted} onClick={finalVerify}><Check size={16}/>执行最终留出集复核</button>}
      {item.status === "review" ? <div className="optimization-actions"><button className="button primary" disabled={busy||item.proposalOnly||!reviewAccepted||Boolean(item.holdoutFingerprint&&!item.holdoutVerified)} onClick={() => decide("adopt")}><Check size={16} />保留为可用候选</button><button className="button secondary" disabled={busy} onClick={() => decide("retain")}>沿用原版</button><span>{item.proposalOnly?'该候选由持续改进任务管理。':item.holdoutFingerprint&&!item.holdoutVerified?'采纳前需完成已配置的留出集复核。':item.holdoutVerified?'仅保存本地选择，不自动发布或替换现有 Skill。':'未配置留出集；选择基于开发集和独立审查，不代表集外效果已验证。'}</span></div> : null}
      {item.status === "adopted" || item.status === "retained" ? <div className="info-banner">{item.status === "adopted" ? "已保留候选，可在版本选择中继续评测。原版未改变。" : "已选择沿用原版，候选和复测证据仍保留。"}</div> : null}
    </> : null}
  </section>;
}
