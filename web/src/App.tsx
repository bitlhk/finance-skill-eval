import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Archive,
  ArrowRight,
  Bot,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Download,
  FileArchive,
  FlaskConical,
  History,
  Network,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ServerCog,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import type {
  Catalog,
  Environment,
  EvalCaseSummary,
  EvaluationJob,
  Preparation,
} from "./types";

type View = "evaluation" | "skills" | "environment" | "history";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("finance-eval-token");
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body instanceof Blob ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try { message = (JSON.parse(text) as { message?: string }).message ?? text; } catch { /* noop */ }
    throw new Error(message || `HTTP ${response.status}`);
  }
  return text ? JSON.parse(text) as T : {} as T;
}

function statusText(status: EvaluationJob["status"]): string {
  return ({
    queued: "排队中",
    preparing: "准备中",
    running: "执行中",
    judging: "评阅中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
  })[status];
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

export function App() {
  const [view, setView] = useState<View>("evaluation");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selection, setSelection] = useState("");
  const [selectedCases, setSelectedCases] = useState<string[]>([]);
  const [runtime, setRuntime] = useState<"replay" | "direct_model" | "runtime_http">("replay");
  const [runtimeEnvironmentId, setRuntimeEnvironmentId] = useState("");
  const [judgeMode, setJudgeMode] = useState<"deterministic" | "model">("deterministic");
  const [activeJob, setActiveJob] = useState<EvaluationJob | null>(null);
  const [history, setHistory] = useState<EvaluationJob[]>([]);
  const [selectedHistory, setSelectedHistory] = useState<EvaluationJob | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);

  const refresh = async () => {
    const [nextCatalog, runs] = await Promise.all([
      api<Catalog>("/api/catalog"),
      api<{ runs: EvaluationJob[] }>("/api/runs?limit=30"),
    ]);
    setCatalog(nextCatalog);
    setHistory(runs.runs);
    setSelection(current => current || (
      nextCatalog.evalPacks.find(item => item.targetSkillId === "wealth-manager-assistant")
        ? `pack:${nextCatalog.evalPacks.find(item => item.targetSkillId === "wealth-manager-assistant")!.packId}`
        : nextCatalog.evalPacks[0] ? `pack:${nextCatalog.evalPacks[0].packId}` : ""
    ));
  };

  useEffect(() => {
    void refresh().catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      streamRef.current?.close();
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, []);

  const selectedPack = selection.startsWith("pack:")
    ? catalog?.evalPacks.find(item => item.packId === selection.slice(5)) ?? null
    : null;
  const selectedPreparation = selection.startsWith("prep:")
    ? catalog?.preparations.find(item => item.preparationId === selection.slice(5)) ?? null
    : null;
  const cases: EvalCaseSummary[] = selectedPack?.cases ?? selectedPreparation?.cases ?? [];
  const selectedUploadedSkill = selectedPreparation
    ? catalog?.uploadedSkills.find(item => item.assetId === selectedPreparation.skillAssetId) ?? null
    : null;
  const runtimeEnvironments = catalog?.environments.filter(item => item.type === "runtime_http") ?? [];

  useEffect(() => {
    setSelectedCases(cases.map(item => item.caseId));
    if (selectedPack) setRuntime(selectedPack.replayReady ? "replay" : "runtime_http");
    if (selectedPreparation) {
      setRuntime(catalog?.modelRoles.execution.configured ? "direct_model" : "runtime_http");
    }
  }, [selection]);

  const connectStream = (jobId: string) => {
    streamRef.current?.close();
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }

    const poll = () => {
      let inFlight = false;
      const update = async () => {
        if (inFlight) return;
        inFlight = true;
        try {
          const job = await api<EvaluationJob>(`/api/runs/${jobId}`);
          setActiveJob(job);
          if (TERMINAL.has(job.status)) {
            if (pollRef.current !== null) window.clearInterval(pollRef.current);
            pollRef.current = null;
            await refresh();
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          inFlight = false;
        }
      };
      void update();
      pollRef.current = window.setInterval(() => void update(), 1000);
    };

    // EventSource cannot attach a bearer header. Authenticated deployments use
    // the regular API polling path so access tokens never appear in URLs.
    if (localStorage.getItem("finance-eval-token")) {
      poll();
      return;
    }
    const source = new EventSource(`/api/runs/${jobId}/events`);
    streamRef.current = source;
    source.addEventListener("job", event => {
      const job = JSON.parse((event as MessageEvent).data) as EvaluationJob;
      setActiveJob(job);
      if (TERMINAL.has(job.status)) {
        source.close();
        void refresh();
      }
    });
    source.onerror = () => {
      source.close();
      poll();
    };
  };

  const startRun = async () => {
    if (!selection || selectedCases.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const job = await api<EvaluationJob>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          ...(selectedPack ? { packId: selectedPack.packId } : { preparationId: selectedPreparation!.preparationId }),
          runtime: runtime === "runtime_http"
            ? { type: runtime, environmentId: runtimeEnvironmentId }
            : { type: runtime },
          judgeMode,
          selectedCaseIds: selectedCases,
          ...(selectedUploadedSkill ? { skillAssetId: selectedUploadedSkill.assetId } : {}),
          timeoutMs: 310000,
        }),
      });
      setActiveJob(job);
      connectStream(job.jobId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const cancelRun = async () => {
    if (!activeJob) return;
    const job = await api<EvaluationJob>(`/api/runs/${activeJob.jobId}/cancel`, { method: "POST" });
    setActiveJob(job);
  };

  const retryRun = async (job: EvaluationJob) => {
    setBusy(true);
    try {
      const retried = await api<EvaluationJob>(`/api/runs/${job.jobId}/retry`, { method: "POST" });
      setActiveJob(retried);
      setView("evaluation");
      connectStream(retried.jobId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const currentResult = activeJob?.report ? activeJob : selectedHistory?.report ? selectedHistory : activeJob;
  const runIsActive = activeJob ? !TERMINAL.has(activeJob.status) : false;
  const canStart = Boolean(
    selection && selectedCases.length
    && (runtime !== "runtime_http" || runtimeEnvironmentId)
    && !(runtime === "direct_model" && !catalog?.modelRoles.execution.configured)
    && !(judgeMode === "model" && !catalog?.modelRoles.judge.configured)
    && !runIsActive,
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark"><FlaskConical size={21} /></div>
        <div className="brand-copy">
          <strong>Finance Skill Eval</strong>
          <span>金融 Skill 专业价值评测</span>
        </div>
        <div className="method-strip">
          <span><Archive size={14} /> Agent Skill</span>
          <span><Activity size={14} /> Promptfoo Runner</span>
          <span><ShieldCheck size={14} /> 金融 Judge</span>
        </div>
        <div className="service-version">Service v{catalog?.serviceVersion ?? "..."}</div>
      </header>

      <aside className="sidebar">
        <nav>
          <NavButton icon={<FlaskConical />} label="对比评测" active={view === "evaluation"} onClick={() => setView("evaluation")} />
          <NavButton icon={<Upload />} label="Skill 资产" active={view === "skills"} onClick={() => setView("skills")} />
          <NavButton icon={<Network />} label="测试环境" active={view === "environment"} onClick={() => setView("environment")} />
          <NavButton icon={<History />} label="运行记录" active={view === "history"} onClick={() => setView("history")} />
        </nav>
        <div className="sidebar-note">
          <span className="status-dot" />
          <div><strong>独立评测服务</strong><small>不依赖 EA 进程</small></div>
        </div>
      </aside>

      <main className="main-content">
        {error ? (
          <div className="error-banner"><CircleAlert size={18} /><span>{error}</span><button title="关闭" onClick={() => setError("")}><X size={16} /></button></div>
        ) : null}
        {view === "evaluation" && catalog ? (
          <EvaluationView
            catalog={catalog}
            selection={selection}
            setSelection={setSelection}
            cases={cases}
            selectedCases={selectedCases}
            setSelectedCases={setSelectedCases}
            runtime={runtime}
            setRuntime={setRuntime}
            runtimeEnvironmentId={runtimeEnvironmentId}
            setRuntimeEnvironmentId={setRuntimeEnvironmentId}
            judgeMode={judgeMode}
            setJudgeMode={setJudgeMode}
            job={currentResult}
            onStart={startRun}
            onCancel={cancelRun}
            onRetry={() => activeJob && retryRun(activeJob)}
            canStart={canStart && !busy}
          />
        ) : null}
        {view === "skills" && catalog ? <SkillAssetsView catalog={catalog} onChanged={refresh} onSelectPreparation={id => { setSelection(`prep:${id}`); setView("evaluation"); }} /> : null}
        {view === "environment" && catalog ? <EnvironmentView catalog={catalog} onChanged={refresh} /> : null}
        {view === "history" ? <HistoryView jobs={history} selected={selectedHistory} onSelect={setSelectedHistory} onRetry={retryRun} /> : null}
      </main>
    </div>
  );
}

function NavButton({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick(): void }) {
  return <button className={active ? "nav-button active" : "nav-button"} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function EvaluationView(props: {
  catalog: Catalog;
  selection: string;
  setSelection(value: string): void;
  cases: EvalCaseSummary[];
  selectedCases: string[];
  setSelectedCases(value: string[]): void;
  runtime: "replay" | "direct_model" | "runtime_http";
  setRuntime(value: "replay" | "direct_model" | "runtime_http"): void;
  runtimeEnvironmentId: string;
  setRuntimeEnvironmentId(value: string): void;
  judgeMode: "deterministic" | "model";
  setJudgeMode(value: "deterministic" | "model"): void;
  job: EvaluationJob | null;
  onStart(): void;
  onCancel(): void;
  onRetry(): void;
  canStart: boolean;
}) {
  const isPreparation = props.selection.startsWith("prep:");
  const target = props.catalog.evalPacks.find(item => `pack:${item.packId}` === props.selection)
    ?? props.catalog.preparations.find(item => `prep:${item.preparationId}` === props.selection);
  const active = props.job && !TERMINAL.has(props.job.status);
  return (
    <div className="workspace">
      <section className="workspace-header">
        <div><span className="eyebrow">SKILL VALUE COMPARISON</span><h1>同条件对比评测</h1><p>保持题目、模型与环境一致，只改变 Skill 装配，观察专业结果差异。</p></div>
        <div className="header-actions">
          {active ? <button className="button secondary danger" onClick={props.onCancel}><CircleStop size={17} />取消</button> : null}
          {props.job && ["failed", "cancelled", "interrupted"].includes(props.job.status) ? <button className="button secondary" onClick={props.onRetry}><RotateCcw size={17} />单次重试</button> : null}
          <button className="button primary" disabled={!props.canStart} onClick={props.onStart}><Play size={17} />开始测试</button>
        </div>
      </section>

      <section className="configuration-band">
        <label className="field wide"><span>评测对象</span><select value={props.selection} onChange={event => props.setSelection(event.target.value)}>
          <optgroup label="预制金融 Skill">
            {props.catalog.evalPacks.map(pack => <option key={pack.packId} value={`pack:${pack.packId}`}>{pack.targetSkillId} · v{pack.targetSkillVersion}</option>)}
          </optgroup>
          {props.catalog.preparations.length ? <optgroup label="上传 Skill 的测试方案">
            {props.catalog.preparations.map(item => <option key={item.preparationId} value={`prep:${item.preparationId}`}>{item.skillId} · {item.source === "ai_generated" ? "AI 出题" : "手工试题"}</option>)}
          </optgroup> : null}
        </select></label>
        <label className="field"><span>执行方式</span><select value={props.runtime} onChange={event => props.setRuntime(event.target.value as typeof props.runtime)}>
          {!isPreparation ? <option value="replay">冻结证据回放</option> : null}
          {isPreparation ? <option value="direct_model" disabled={!props.catalog.modelRoles.execution.configured}>文本 Skill 直测</option> : null}
          <option value="runtime_http">外部 Agent Runtime</option>
        </select></label>
        {props.runtime === "runtime_http" ? <label className="field"><span>Runtime 环境</span><select value={props.runtimeEnvironmentId} onChange={event => props.setRuntimeEnvironmentId(event.target.value)}>
          <option value="">请选择</option>
          {props.catalog.environments.filter(item => item.type === "runtime_http").map(item => <option value={item.environmentId} key={item.environmentId}>{item.name}</option>)}
        </select></label> : null}
        <label className="field"><span>评分方式</span><select value={props.judgeMode} onChange={event => props.setJudgeMode(event.target.value as typeof props.judgeMode)}>
          <option value="deterministic">规则量表</option>
          <option value="model" disabled={!props.catalog.modelRoles.judge.configured}>匿名模型 Judge</option>
        </select></label>
      </section>

      <div className="comparison-grid">
        <ComparisonPanel side="A" title="对照组" value="不装配目标 Skill" model={props.catalog.modelRoles.execution.model.modelId} muted />
        <div className="comparison-arrow"><ArrowRight size={20} /></div>
        <ComparisonPanel side="B" title="目标组" value={target ? `${"targetSkillId" in target ? target.targetSkillId : target.skillId}@${"targetSkillVersion" in target ? target.targetSkillVersion : target.skillVersion}` : "请选择 Skill"} model={props.catalog.modelRoles.execution.model.modelId} />
      </div>

      <section className="cases-section">
        <div className="section-title"><div><h2>评测任务</h2><p>{target && "description" in target ? target.description : target?.summary}</p></div><span>{props.selectedCases.length}/{props.cases.length} 题</span></div>
        <div className="case-list">
          {props.cases.map((item, index) => {
            const checked = props.selectedCases.includes(item.caseId);
            return <label key={item.caseId} className={checked ? "case-row selected" : "case-row"}>
              <input type="checkbox" checked={checked} onChange={() => props.setSelectedCases(checked ? props.selectedCases.filter(id => id !== item.caseId) : [...props.selectedCases, item.caseId])} />
              <span className="case-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="case-copy"><strong>{item.name}</strong><small>{item.prompt}</small><em>{item.evaluationGoal}</em></span>
              <span className={item.requiredTools.length ? "tool-label" : "tool-label neutral"}>{item.requiredTools.length ? `${item.requiredTools.length} 个工具` : "文本任务"}</span>
            </label>;
          })}
        </div>
      </section>

      {props.job ? <RunEvidence job={props.job} /> : <EmptyRun />}
    </div>
  );
}

function ComparisonPanel({ side, title, value, model, muted = false }: { side: string; title: string; value: string; model: string; muted?: boolean }) {
  return <section className={muted ? "comparison-panel muted" : "comparison-panel target"}>
    <div className="side-badge">{side}</div><div><span>{title}</span><strong>{value}</strong><small><Bot size={13} />{model || "由 Eval Pack 指定"}</small></div>
  </section>;
}

function EmptyRun() {
  return <section className="empty-run"><FlaskConical size={28} /><strong>选择任务后开始一轮对比</strong><p>运行过程会实时展示左右输出、工具证据、Judge 结论和可复核报告指纹。</p></section>;
}

function RunEvidence({ job }: { job: EvaluationJob }) {
  const progress = job.progress.totalRuns ? Math.round(job.progress.completedRuns / job.progress.totalRuns * 100) : 0;
  return <section className="run-section">
    <div className="run-head">
      <div><span className={`run-status ${job.status}`}>{statusText(job.status)}</span><h2>{job.report?.summary.headline ?? job.stageLabel}</h2><p className="mono">{job.jobId}</p></div>
      <div className="progress-block"><strong>{progress}%</strong><div><span style={{ width: `${progress}%` }} /></div><small>{job.progress.completedRuns}/{job.progress.totalRuns || "-"} 次候选执行</small></div>
    </div>
    {job.configuration.runtime.type === "replay" ? <div className="evidence-notice"><Archive size={16} /><span><strong>冻结证据回放</strong>：本轮复核已固化输出和评分，不代表刚刚重新调用了 Agent。</span></div> : <div className="evidence-notice live"><Activity size={16} /><span><strong>在线执行</strong>：左右候选通过所选 Runtime 在本轮实际运行。</span></div>}
    {job.error ? <div className="run-error"><CircleAlert size={17} /><div><strong>{job.error.code}</strong><p>{job.error.message}</p></div></div> : null}
    {job.report ? <ReportResult job={job} /> : <LiveEvidence job={job} />}
  </section>;
}

function LiveEvidence({ job }: { job: EvaluationJob }) {
  const byCase = [...new Set(job.evidence.map(item => item.caseId))];
  if (!byCase.length) return <div className="live-wait"><RefreshCw className="spin" size={20} />{job.stageLabel}</div>;
  return <div className="live-cases">{byCase.map(caseId => <div className="live-case" key={caseId}><h3>{caseId}</h3><div className="answer-grid">{(["left", "right"] as const).map(side => {
    const evidence = job.evidence.find(item => item.caseId === caseId && item.side === side);
    return <article key={side}><span>{side === "left" ? "A · 对照组" : "B · 目标组"}</span><p>{evidence?.output || evidence?.error || "等待输出"}</p></article>;
  })}</div></div>)}</div>;
}

function ReportResult({ job }: { job: EvaluationJob }) {
  const report = job.report!;
  return <div className="report-result">
    <div className="score-strip">
      <div><span>A 胜</span><strong>{report.summary.leftWins}</strong></div><div className="winner-metric"><span>B 胜</span><strong>{report.summary.rightWins}</strong></div><div><span>持平</span><strong>{report.summary.ties}</strong></div><div><span>平均耗时</span><strong>{Math.round((report.summary.meanElapsedMs.left + report.summary.meanElapsedMs.right) / 2000)}s</strong></div>
      <div className="report-downloads"><a href={`/api/runs/${job.jobId}/export?format=html`} target="_blank" rel="noreferrer"><Download size={15} />HTML</a><a href={`/api/runs/${job.jobId}/export?format=json`}><Download size={15} />JSON</a></div>
    </div>
    {report.cases.map(item => <section className="result-case" key={item.caseId}>
      <header><div><span>{item.caseId}</span><h3>{item.name}</h3></div><strong className={`winner winner-${item.judge?.winner ?? "none"}`}>{item.judge?.winner === "right" ? "B 更优" : item.judge?.winner === "left" ? "A 更优" : item.judge ? "持平" : "未评阅"}</strong></header>
      <div className="answer-grid"><article><span>A · 对照组</span><p>{item.left.output}</p></article><article><span>B · 目标组</span><p>{item.right.output}</p></article></div>
      <div className="judge-summary"><Sparkles size={17} /><div><strong>金融专业评价</strong><p>{item.judge?.summary ?? item.judgeError}</p>{item.judge ? <div className="dimension-grid">{item.judge.dimensions.map(dimension => <div key={dimension.id}><span>{dimension.label}</span><b>{dimension.leftScore} / {dimension.rightScore}</b><small>{dimension.reason}</small></div>)}</div> : null}</div></div>
    </section>)}
    <footer className="report-footer"><span>Runtime: {report.runtimeAdapterId}</span><span>Judge: {report.judgeId}</span><span className="mono">报告 {report.reportFingerprint.slice(0, 16)}</span></footer>
  </div>;
}

function SkillAssetsView({ catalog, onChanged, onSelectPreparation }: { catalog: Catalog; onChanged(): Promise<void>; onSelectPreparation(id: string): void }) {
  const [uploading, setUploading] = useState(false);
  const [preparing, setPreparing] = useState("");
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const upload = async (file: File) => {
    setUploading(true); setMessage("");
    try {
      await api("/api/skills/upload", { method: "POST", body: file, headers: { "content-type": "application/zip" } });
      await onChanged(); setMessage("Skill 已上传并完成结构校验。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
    finally { setUploading(false); }
  };
  const prepare = async (assetId: string) => {
    setPreparing(assetId); setMessage("");
    try {
      const preparation = await api<Preparation>(`/api/skills/${assetId}/prepare`, { method: "POST", body: JSON.stringify({ maximumCases: 4 }) });
      await onChanged(); setMessage(`已生成 ${preparation.cases.length} 道高区分度测试题。`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPreparing(""); }
  };
  return <div className="workspace"><section className="workspace-header"><div><span className="eyebrow">SKILL ARTIFACTS</span><h1>Skill 资产</h1><p>上传候选 ZIP，校验 SKILL.md 后由 Analyzer 生成测试方案。</p></div><button className="button primary" onClick={() => inputRef.current?.click()} disabled={uploading}><FileArchive size={17} />{uploading ? "上传中" : "上传 Skill ZIP"}</button><input hidden ref={inputRef} type="file" accept=".zip,application/zip" onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }} /></section>
    {message ? <div className="info-banner">{message}</div> : null}
    <section className="asset-section"><div className="section-title"><div><h2>用户上传</h2><p>上传资产只用于当前评测服务，不会发布到 Skill 市场。</p></div><span>{catalog.uploadedSkills.length} 个</span></div>
      <div className="asset-table">{catalog.uploadedSkills.length ? catalog.uploadedSkills.map(skill => {
        const preps = catalog.preparations.filter(item => item.skillAssetId === skill.assetId);
        return <div className="asset-row" key={skill.assetId}><div className="asset-icon"><FileArchive size={20} /></div><div><strong>{skill.displayName}</strong><small>{skill.skillId}@{skill.version} · {skill.fileCount} 个文件</small><p>{skill.description}</p><em className="mono">SHA {skill.artifactSha256.slice(0, 16)}</em></div><div className="asset-actions"><button className="button secondary" onClick={() => prepare(skill.assetId)} disabled={preparing === skill.assetId || !catalog.modelRoles.analyzer.configured}><Sparkles size={16} />{preparing === skill.assetId ? "出题中" : "AI 生成试题"}</button>{preps[0] ? <button className="icon-button" title="进入评测" onClick={() => onSelectPreparation(preps[0].preparationId)}><ChevronRight size={18} /></button> : null}</div></div>;
      }) : <div className="empty-table">尚未上传 Skill ZIP</div>}</div>
    </section>
    <section className="asset-section"><div className="section-title"><div><h2>预制 Eval Pack</h2><p>由金融 SOP、Golden Cases 与 Judge Rubric 共同定义。</p></div><span>{catalog.evalPacks.length} 套</span></div><div className="asset-table">{catalog.evalPacks.map(pack => <div className="asset-row" key={pack.packId}><div className="asset-icon"><Archive size={20} /></div><div><strong>{pack.targetSkillId}</strong><small>v{pack.targetSkillVersion} · {pack.caseCount} 题 · {pack.domain}</small><p>{pack.description}</p><em className="mono">PACK {pack.fingerprint.slice(0, 16)}</em></div><span className={pack.replayReady ? "state-tag ready" : "state-tag"}>{pack.replayReady ? "可回放" : "需在线 Runtime"}</span></div>)}</div></section>
  </div>;
}

function EnvironmentView({ catalog, onChanged }: { catalog: Catalog; onChanged(): Promise<void> }) {
  const [form, setForm] = useState({ name: "", type: "runtime_http", endpoint: "", credentialEnv: "" });
  const [result, setResult] = useState<Record<string, string>>( {} );
  const [saving, setSaving] = useState(false);
  const create = async () => {
    setSaving(true);
    try { await api("/api/environments", { method: "POST", body: JSON.stringify({ ...form, credentialEnv: form.credentialEnv || null, mcpEnvironmentIds: [] }) }); setForm({ name: "", type: "runtime_http", endpoint: "", credentialEnv: "" }); await onChanged(); }
    finally { setSaving(false); }
  };
  const preflight = async (environment: Environment) => {
    setResult(current => ({ ...current, [environment.environmentId]: "检测中" }));
    try { const value = await api<{ status: string; error?: string; tools?: unknown[] }>(`/api/environments/${environment.environmentId}/preflight`, { method: "POST" }); setResult(current => ({ ...current, [environment.environmentId]: value.status === "ready" ? `就绪${value.tools ? ` · ${value.tools.length} 个工具` : ""}` : value.error || "失败" })); }
    catch (cause) { setResult(current => ({ ...current, [environment.environmentId]: cause instanceof Error ? cause.message : String(cause) })); }
  };
  return <div className="workspace"><section className="workspace-header"><div><span className="eyebrow">TEST ENVIRONMENTS</span><h1>测试环境</h1><p>登记外部 Agent Runtime 或 MCP 服务，并在评测前验证可达性与工具清单。</p></div></section>
    <section className="environment-form"><label className="field"><span>环境名称</span><input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="上海 EA Runtime" /></label><label className="field"><span>类型</span><select value={form.type} onChange={event => setForm({ ...form, type: event.target.value })}><option value="runtime_http">Agent Runtime HTTP</option><option value="mcp_streamable_http">MCP Streamable HTTP</option></select></label><label className="field wide"><span>服务地址</span><input value={form.endpoint} onChange={event => setForm({ ...form, endpoint: event.target.value })} placeholder="https://agent.example.com/eval/execute" /></label><label className="field"><span>凭据环境变量</span><input value={form.credentialEnv} onChange={event => setForm({ ...form, credentialEnv: event.target.value })} placeholder="可选，不填写密钥值" /></label><button className="button primary" onClick={create} disabled={saving || !form.name || !form.endpoint}><Plus size={17} />添加环境</button></section>
    <section className="asset-section"><div className="section-title"><div><h2>已登记环境</h2><p>金融 Skill Eval 保存连接声明，凭据只从服务端环境变量读取。</p></div><span>{catalog.environments.length} 个</span></div><div className="asset-table">{catalog.environments.length ? catalog.environments.map(environment => <div className="asset-row" key={environment.environmentId}><div className="asset-icon"><ServerCog size={20} /></div><div><strong>{environment.name}</strong><small>{environment.type === "runtime_http" ? "Agent Runtime" : "MCP 服务"}</small><p className="mono">{environment.endpoint}</p>{result[environment.environmentId] ? <em>{result[environment.environmentId]}</em> : null}</div><button className="button secondary" onClick={() => preflight(environment)}><Activity size={16} />环境预检</button></div>) : <div className="empty-table">尚未登记外部环境</div>}</div></section>
  </div>;
}

function HistoryView({ jobs, selected, onSelect, onRetry }: { jobs: EvaluationJob[]; selected: EvaluationJob | null; onSelect(job: EvaluationJob): void; onRetry(job: EvaluationJob): void }) {
  const current = selected ?? jobs[0] ?? null;
  return <div className="workspace"><section className="workspace-header"><div><span className="eyebrow">RUN HISTORY</span><h1>真实运行记录</h1><p>保留运行配置、左右证据、失败原因和可导出报告。</p></div></section><div className="history-layout"><div className="history-list">{jobs.map(job => <button key={job.jobId} className={current?.jobId === job.jobId ? "history-item active" : "history-item"} onClick={() => onSelect(job)}><div><strong>{job.pack?.targetSkillId ?? "准备中"}</strong><span className={`run-status ${job.status}`}>{statusText(job.status)}</span></div><small>{formatTime(job.updatedAt)} · {job.pack?.caseCount ?? 0} 题</small><p>{job.report?.summary.headline ?? job.error?.message ?? job.stageLabel}</p></button>)}</div><div>{current ? <><RunEvidence job={current} />{["failed", "cancelled", "interrupted"].includes(current.status) ? <button className="button secondary history-retry" onClick={() => onRetry(current)}><RotateCcw size={16} />重试这一轮</button> : null}</> : <EmptyRun />}</div></div></div>;
}
