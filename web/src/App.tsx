import { api } from "./api-client";
import { EnvironmentView } from "./features/environments/EnvironmentView";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { accessToken, apiPath, basePath, tokenKey, downloadApi } from './api-path';
import {importMigrationFiles,type ImportResult} from './migration-import';
import {
  Activity,
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  BriefcaseBusiness,
  ChartNoAxesCombined,
  ChevronRight,
  CircleCheck,
  CircleAlert,
  CircleStop,
  ClipboardCheck,
  Download,
  ExternalLink,
  FileArchive,
  FlaskConical,
  History,
  Landmark,
  GraduationCap,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  RotateCcw,
  Shield,
  ShieldCheck,
  Sparkles,
  Upload,
  WalletCards,
  X,
} from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";
import { MethodologyView } from "./MethodologyView";
import { ResultCharts } from "./ResultCharts";
import { OptimizationPanel } from "./OptimizationPanel";
import { MigrationPanel } from './MigrationPanel';
import type {
  SkillAsset,
  Catalog,
  Environment,
  EnvironmentInspection,
  EvalCaseSummary,
  EvaluationJob,
  FeaturedSkill,
  ModelRef,
  Preparation,
  SkillVariant,
} from "./types";

type View = "catalog" | "evaluation" | "skills" | "migration" | "environment" | "methodology" | "history";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const PublicDemoContext = createContext(false);



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

function modelKey(model: ModelRef): string {
  return `${model.providerId}:${model.modelId}`;
}

function executionReference(model: ModelRef): ModelRef {
  return { providerId: model.providerId, modelId: model.modelId, label: model.label, parameters: model.parameters ?? {} };
}

function directExecutionRole(catalog: Catalog) {
  return catalog.modelRoles.directExecution ?? catalog.modelRoles.execution;
}

function variantSelection(variant: SkillVariant): string {
  return variant.mode === "without_target_skill" ? "without_target_skill" : `version:${variant.version}`;
}

function runtimeTypeLabel(value: Environment["runtimeType"]): string {
  if (value === "openjiuwen") return "OpenJiuwen";
  if (value === "ea") return "EA Runtime";
  return "通用 HTTP Runtime";
}

export function App() {
  const [needsAccess, setNeedsAccess] = useState(false);
  const [accessInput, setAccessInput] = useState("");
  const [view, setView] = useState<View>("catalog");
  const [migrationSource,setMigrationSource]=useState<SkillAsset|null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [selection, setSelection] = useState("");
  const [selectedCases, setSelectedCases] = useState<string[]>([]);
  const [caseSource, setCaseSource] = useState<"fixed" | "ai_generated">("ai_generated");
  const [leftVariantSelection, setLeftVariantSelection] = useState("without_target_skill");
  const [rightVariantSelection, setRightVariantSelection] = useState("");
  const [leftModelKey, setLeftModelKey] = useState("");
  const [rightModelKey, setRightModelKey] = useState("");
  const [runtime, setRuntime] = useState<"replay" | "direct_model" | "runtime_http">("runtime_http");
  const [runtimeEnvironmentId, setRuntimeEnvironmentId] = useState("");
  const [environmentInspection, setEnvironmentInspection] = useState<EnvironmentInspection | null>(null);
  const [environmentChecking, setEnvironmentChecking] = useState(false);
  const inspectionSequence = useRef(0);
  const [judgeMode, setJudgeMode] = useState<"deterministic" | "model">("deterministic");
  const [activeJob, setActiveJob] = useState<EvaluationJob | null>(null);
  const [history, setHistory] = useState<EvaluationJob[]>([]);
  const [selectedHistory, setSelectedHistory] = useState<EvaluationJob | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("finance-eval-sidebar") === "collapsed");
  const streamRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);

  const refresh = async () => {
    const [nextCatalog, runs] = await Promise.all([
      api<Catalog>("/api/catalog"),
      api<{ runs: EvaluationJob[] }>("/api/runs?limit=30"),
    ]);
    setCatalog(nextCatalog);
    setHistory(runs.runs);
    const defaultPack = nextCatalog.evalPacks.find(item => item.targetSkillId === "wealth-manager-assistant")
      ?? nextCatalog.evalPacks[0];
    setSelection(current => current || (defaultPack ? `pack:${defaultPack.packId}` : ""));
    setSelectedSkillId(current => current || defaultPack?.targetSkillId || nextCatalog.featuredSkills[0]?.skillId || "");
    setRuntimeEnvironmentId(current => current || nextCatalog.environments.find(item => item.type === "runtime_http")?.environmentId || "");
  };

  useEffect(() => {
    void refresh().catch(cause => {setError(cause instanceof Error ? cause.message : String(cause));setNeedsAccess(cause?.status===401);});
    const reload = () => { void refresh().catch(cause => setError(String(cause))); };
    window.addEventListener("finance-eval-assets-changed", reload);
    return () => {
      window.removeEventListener("finance-eval-assets-changed", reload);
      streamRef.current?.close();
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed(current => {
      const next = !current;
      localStorage.setItem("finance-eval-sidebar", next ? "collapsed" : "expanded");
      return next;
    });
  };

  const selectedPack = selection.startsWith("pack:")
    ? catalog?.evalPacks.find(item => item.packId === selection.slice(5)) ?? null
    : null;
  const selectedPreparation = selection.startsWith("prep:")
    ? catalog?.preparations.find(item => item.preparationId === selection.slice(5)) ?? null
    : null;
  const cases: EvalCaseSummary[] = selectedPack?.cases ?? selectedPreparation?.cases ?? [];
  const dynamicQuestions = Boolean(selectedPack && runtime !== "replay" && caseSource === "ai_generated");
  const selectedUploadedSkill = selectedPreparation
    ? catalog?.uploadedSkills.find(item => item.assetId === selectedPreparation.skillAssetId) ?? null
    : null;
  const preparationRequiresTools = selectedPreparation?.cases.some(item => item.requiredTools.length > 0) ?? false;
  const selectedFeaturedSkill = catalog?.featuredSkills.find(item => item.skillId === selectedSkillId) ?? null;
  const targetSkillId = selectedPack?.targetSkillId ?? selectedPreparation?.skillId ?? selectedSkillId;
  const packVersionOptions = selectedFeaturedSkill?.versions.map(item => ({
    version: item.version,
    artifactSha256: item.artifactSha256,
    packId: item.packId,
  })) ?? (selectedUploadedSkill ? [{
    version: selectedUploadedSkill.version,
    artifactSha256: selectedUploadedSkill.artifactSha256,
    packId: null,
  }] : []);
  const versionOptions = [...new Map([
    ...packVersionOptions,
    ...(catalog?.uploadedSkills.filter(item => item.skillId === targetSkillId).map(item => ({ version: item.version, artifactSha256: item.artifactSha256, packId: null })) ?? []),
  ].map(item => [item.version, item])).values()];
  useEffect(() => {
    setSelectedCases(cases.map(item => item.caseId));
    if (selectedPack) {
      setRuntime("runtime_http");
      setJudgeMode(catalog?.modelRoles.judge.configured ? "model" : "deterministic");
      setLeftVariantSelection(variantSelection(selectedPack.variants.left));
      setRightVariantSelection(variantSelection(selectedPack.variants.right));
      setLeftModelKey(modelKey(catalog?.modelRoles.execution.configured ? catalog.modelRoles.execution.model : selectedPack.models.execution.left));
      setRightModelKey(modelKey(catalog?.modelRoles.execution.configured ? catalog.modelRoles.execution.model : selectedPack.models.execution.right));
    }
    if (selectedPreparation) {
      setRuntime(
        !preparationRequiresTools && catalog && directExecutionRole(catalog).configured
          ? "direct_model"
          : "runtime_http",
      );
      setLeftVariantSelection("without_target_skill");
      setRightVariantSelection(`version:${selectedPreparation.skillVersion}`);
      const executionModel = catalog?.modelRoles.execution.model;
      if (executionModel) {
        setLeftModelKey(modelKey(executionModel));
        setRightModelKey(modelKey(executionModel));
      }
    }
  }, [selection, catalog]);

  useEffect(() => {
    if (runtime === "direct_model" && catalog) {
      const key = modelKey(directExecutionRole(catalog).model);
      setLeftModelKey(key);
      setRightModelKey(key);
    }
  }, [runtime, catalog]);

  const inspectEnvironment = async (environmentId: string) => {
    const sequence = ++inspectionSequence.current;
    if (!environmentId) {
      setEnvironmentInspection(null);
      return;
    }
    setEnvironmentChecking(true);
    setEnvironmentInspection(null);
    try {
      const inspection=await api<EnvironmentInspection>(`/api/environments/${environmentId}/preflight`, { method: "POST" });
      if(sequence===inspectionSequence.current) setEnvironmentInspection(inspection);
    } catch (cause) {
      if(sequence!==inspectionSequence.current) return;
      setEnvironmentInspection({
        status: "failed",
        elapsedMs: 0,
        error: cause instanceof Error ? cause.message : String(cause),
        toolCount: 0,
        tools: [],
        mcpServers: [],
      });
    } finally {
      if(sequence===inspectionSequence.current) setEnvironmentChecking(false);
    }
  };

  useEffect(() => {
    if (runtime !== "runtime_http" || !runtimeEnvironmentId) {
      setEnvironmentInspection(null);
      return;
    }
    void inspectEnvironment(runtimeEnvironmentId);
  }, [runtime, runtimeEnvironmentId, selection]);

  const openSkillEvaluation = (skill: FeaturedSkill) => {
    const version = skill.versions[0];
    if (!version) return;
    const pack = catalog?.evalPacks.find(p=>p.packId===version.packId);
    setSelectedCases(pack?.cases.map(c=>c.caseId) ?? []);
    setActiveJob(null);
    setSelectedHistory(null);
    setSelectedSkillId(skill.skillId);
    setSelection(`pack:${version.packId}`);
    setView("evaluation");
  };

  const selectedLeftModel = runtime === "direct_model" && catalog ? directExecutionRole(catalog).model : catalog?.models.find(item => modelKey(item) === leftModelKey)
    ?? selectedPack?.models.execution.left
    ?? catalog?.modelRoles.execution.model;
  const selectedRightModel = runtime === "direct_model" && catalog ? directExecutionRole(catalog).model : catalog?.models.find(item => modelKey(item) === rightModelKey)
    ?? selectedPack?.models.execution.right
    ?? catalog?.modelRoles.execution.model;
  const resolveVariant = (value: string): SkillVariant => {
    if (value === "without_target_skill") return { mode: "without_target_skill", skillId: targetSkillId };
    const version = value.replace(/^version:/u, "");
    const option = versionOptions.find(item => item.version === version);
    return {
      mode: "skill_version",
      skillId: targetSkillId,
      version,
      ...(option?.artifactSha256 ? { artifactSha256: option.artifactSha256 } : {}),
    };
  };
  const sameConfiguration = leftVariantSelection === rightVariantSelection && leftModelKey === rightModelKey;
  const mixedVariables = leftVariantSelection !== rightVariantSelection && leftModelKey !== rightModelKey;
  const selectedVariantsHaveArtifacts = [leftVariantSelection, rightVariantSelection].every(value => {
    if (value === "without_target_skill") return true;
    const option = versionOptions.find(item => `version:${item.version}` === value);
    return Boolean(option && catalog?.uploadedSkills.some(asset =>
      asset.skillId === targetSkillId
      && asset.version === option.version
      && (!option.artifactSha256 || asset.artifactSha256 === option.artifactSha256),
    ));
  });
  const changeRightVariant = (value: string) => {
    setRightVariantSelection(value);
  };

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
    if (accessToken()) {
      poll();
      return;
    }
    const source = new EventSource(apiPath(`/api/runs/${jobId}/events`));
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
    if (!selection || (!dynamicQuestions && selectedCases.length === 0)) return;
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
          leftVariant: resolveVariant(leftVariantSelection),
          rightVariant: resolveVariant(rightVariantSelection),
          ...(selectedLeftModel ? { leftExecutionModel: executionReference(selectedLeftModel) } : {}),
          ...(selectedRightModel ? { rightExecutionModel: executionReference(selectedRightModel) } : {}),
          caseSource: dynamicQuestions ? "ai_generated" : "fixed",
          selectedCaseIds: dynamicQuestions ? [] : selectedCases,
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
    setCaseSource(job.configuration.caseSource ?? "fixed");
    try {
      const packId = job.configuration.packId;
      const pack = packId ? catalog?.evalPacks.find(item => item.packId === packId) : null;
      if (pack) {
        setSelectedSkillId(pack.targetSkillId);
        setSelection(`pack:${pack.packId}`);
      }
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
    selection && (dynamicQuestions ? catalog?.modelRoles.analyzer.configured && judgeMode === "model" : selectedCases.length && selectedCases.every(id=>cases.some(c=>c.caseId===id)))
    && !environmentChecking
    && (runtime !== "replay" || Boolean(selectedPack?.replayReady))
    && (runtime === "replay" || [selectedLeftModel, selectedRightModel].every(m => m && (!m.availability || m.availability === "ready")))
    && (runtime !== "runtime_http" || selectedVariantsHaveArtifacts)
    && (runtime !== "runtime_http" || runtimeEnvironmentId)
    && (runtime !== "runtime_http" || environmentInspection?.status === "ready")
    && !(runtime === "direct_model" && (!catalog || !directExecutionRole(catalog).configured))
    && !(judgeMode === "model" && !catalog?.modelRoles.judge.configured)
    && !sameConfiguration
    && !runIsActive,
  );

  return (
    <PublicDemoContext.Provider value={Boolean(catalog?.publicDemo)}><div className={`${sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}${catalog?.publicDemo ? " public-demo" : ""}`}>
      <aside className="sidebar">
        <div>
          <div className="sidebar-brand">
            <button className="brand-home" title="返回精选技能" onClick={() => setView("catalog")}><span className="brand-mark"><FlaskConical size={21} /></span><span className="brand-copy"><strong>Finance Skill Eval</strong><small>金融 Skill 专业价值评测</small></span></button>
            <button className="sidebar-toggle" title={sidebarCollapsed ? "展开导航" : "收起导航"} aria-label={sidebarCollapsed ? "展开导航" : "收起导航"} onClick={toggleSidebar}>
              {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
          </div>
          <nav>
            <NavButton icon={<BriefcaseBusiness />} label="精选技能" active={view === "catalog"} onClick={() => setView("catalog")} />
            <NavButton icon={<FlaskConical />} label="对比评测" active={view === "evaluation"} onClick={() => setView("evaluation")} />
            {catalog?.publicDemo === false ? <NavButton icon={<Upload />} label="Skill 资产" active={view === "skills"} onClick={() => setView("skills")} /> : null}
            {catalog?.publicDemo === false ? <NavButton icon={<ArrowRightLeft />} label="Skill 迁移" active={view === "migration"} onClick={() => {setMigrationSource(null);setView("migration");}} /> : null}
            <NavButton icon={<Network />} label="测试环境" active={view === "environment"} onClick={() => setView("environment")} />
            <NavButton icon={<ShieldCheck />} label="评测方法" active={view === "methodology"} onClick={() => setView("methodology")} />
            <NavButton icon={<History />} label="运行记录" active={view === "history"} onClick={() => setView("history")} />
          </nav>
        </div>
        <div className="sidebar-footer">
          <div className="sidebar-note"><span className="status-dot" /><div><strong>独立评测服务</strong><small>运行正常</small></div></div>
          <span className="sidebar-version">v{catalog?.serviceVersion ?? "..."}</span>
        </div>
      </aside>

      <main className="main-content">
        {needsAccess && (basePath!=='/' || ['127.0.0.1','localhost'].includes(window.location.hostname)) ? <form className="migration-panel" onSubmit={event=>{
          event.preventDefault();localStorage.setItem(tokenKey,accessInput);
          void refresh().then(()=>{setNeedsAccess(false);setAccessInput('');setError('');}).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));
        }}><h2>私有工作区</h2><label>访问令牌<input type="password" autoComplete="off" value={accessInput} onChange={event=>setAccessInput(event.target.value)}/></label><button className="button primary" type="submit" disabled={!accessInput.trim()}>进入工作区</button></form> : null}
        {catalog?.publicDemo ? <div className="demo-notice">灵感平台演示 · 模拟业务数据 · 每人每日 3 轮 · 运行记录为共享演示证据</div> : null}
        <div className="mobile-brand"><span className="brand-mark"><FlaskConical size={19} /></span><span><strong>Finance Skill Eval</strong><small>金融 Skill 专业价值评测</small></span></div>
        {error ? (
          <div className="error-banner"><CircleAlert size={18} /><span>{error}</span><button title="关闭" onClick={() => setError("")}><X size={16} /></button></div>
        ) : null}
        {view === "catalog" && catalog ? (
          <SkillCatalogView catalog={catalog} onEvaluate={openSkillEvaluation} />
        ) : null}
        {view === "evaluation" && catalog ? (
          <EvaluationView
            catalog={catalog}
            featuredSkill={selectedFeaturedSkill}
            selection={selection}
            cases={cases}
            caseSource={dynamicQuestions ? "ai_generated" : "fixed"}
            setCaseSource={setCaseSource}
            selectedCases={selectedCases}
            setSelectedCases={setSelectedCases}
            runtime={runtime}
            setRuntime={setRuntime}
            directModelAllowed={!preparationRequiresTools}
            runtimeEnvironmentId={runtimeEnvironmentId}
            setRuntimeEnvironmentId={setRuntimeEnvironmentId}
            environmentInspection={environmentInspection}
            environmentChecking={environmentChecking}
            onInspectEnvironment={() => void inspectEnvironment(runtimeEnvironmentId)}
            judgeMode={judgeMode}
            setJudgeMode={setJudgeMode}
            leftVariantSelection={leftVariantSelection}
            rightVariantSelection={rightVariantSelection}
            setLeftVariantSelection={setLeftVariantSelection}
            setRightVariantSelection={changeRightVariant}
            leftModelKey={leftModelKey}
            rightModelKey={rightModelKey}
            setLeftModelKey={setLeftModelKey}
            setRightModelKey={setRightModelKey}
            versionOptions={versionOptions}
            sameConfiguration={sameConfiguration}
            mixedVariables={mixedVariables}
            job={currentResult}
            onStart={startRun}
            onCancel={cancelRun}
            onRetry={() => activeJob && retryRun(activeJob)}
            canStart={canStart && !busy}
            selectedVariantsHaveArtifacts={selectedVariantsHaveArtifacts}
            onBack={() => setView("catalog")}
          />
        ) : null}
        {view === "migration" && catalog?.publicDemo===false ? <MigrationWorkspace catalog={catalog} source={migrationSource} onChanged={refresh}/> : null}
        {view === "skills" && catalog ? <SkillAssetsView catalog={catalog} onChanged={refresh} onMigrate={asset=>{setMigrationSource(asset);setView('migration');}} onSelectPreparation={id => {
          const preparation = catalog.preparations.find(item => item.preparationId === id);
          if (preparation) setSelectedSkillId(preparation.skillId);
          setSelection(`prep:${id}`);
          setView("evaluation");
        }} /> : null}
        {view === "environment" && catalog ? <EnvironmentView catalog={catalog} onChanged={refresh} /> : null}
        {view === "methodology" ? <MethodologyView /> : null}
        {view === "history" ? <HistoryView jobs={history} selected={selectedHistory} onSelect={setSelectedHistory} onRetry={retryRun} /> : null}
      </main>
    </div></PublicDemoContext.Provider>
  );
}

function NavButton({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick(): void }) {
  return <button className={active ? "nav-button active" : "nav-button"} title={label} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function SkillIcon({ iconKey }: { iconKey: FeaturedSkill["iconKey"] }) {
  if (iconKey === "coach") return <GraduationCap />;
  if (iconKey === "wealth") return <WalletCards />;
  if (iconKey === "insurance") return <Shield />;
  if (iconKey === "research") return <ChartNoAxesCombined />;
  if (iconKey === "audit") return <ClipboardCheck />;
  return <Landmark />;
}

function SkillCatalogView({ catalog, onEvaluate }: { catalog: Catalog; onEvaluate(skill: FeaturedSkill): void }) {
  const readyCount = catalog.featuredSkills.filter(item => item.evaluationStatus === "ready").length;
  const versionCount = catalog.featuredSkills.reduce((total, item) => total + new Set(item.versions.map(v=>v.version)).size, 0);
  return <div className="workspace">
    <section className="workspace-header catalog-header">
      <div><span className="eyebrow">SKILL EVALUATION</span><h1>灵感金融精选</h1><p>财富 · 保险 · 投研 · 审核 · 风控 · 陪练</p></div>
      <div className="catalog-summary"><span><strong>{readyCount}</strong> 个可评测</span><span><strong>{versionCount}</strong> 个已接入版本</span></div>
    </section>
    <section className="skill-catalog-section">
      <div className="section-title"><div><h2>岗位技能</h2></div><span>{catalog.featuredSkills.length} 项 · 在线模型 / 模拟业务样本</span></div>
      <div className="skill-list">
        {catalog.featuredSkills.map(skill => {
          const ready = skill.evaluationStatus === "ready";
          const status = ready
            ? "可开始评测"
            : skill.evaluationStatus === "environment_required"
              ? "需配置在线 Runtime"
              : "评测资产接入中";
          return <article className="skill-list-item" key={skill.skillId}>
            <div className={`skill-leading icon-${skill.iconKey}`}><SkillIcon iconKey={skill.iconKey} /></div>
            <div className="skill-main">
              <div className="skill-title-row"><span>{skill.category} · {skill.roleName}{skill.author ? ` · ${skill.author}` : ""}</span><h3>{skill.displayName}</h3><small className="mono">{skill.skillId}</small></div>
              <p>{skill.summary}</p>
              <div className="capability-tags">{skill.capabilities.map(item => <span key={item}>{item}</span>)}</div>
            </div>
            <div className="skill-metrics">
              <span><strong>{new Set(skill.versions.map(v=>v.version)).size || "-"}</strong>版本</span>
              <span><strong>{skill.taskCount || "-"}</strong>回归题</span>
              <small>{skill.requiredTools.length ? `${skill.requiredTools.length} 项工具需求` : "文本任务 · 无业务 MCP"}</small>
            </div>
            <div className="skill-action">
              <span className={`evaluation-state ${ready ? "ready" : "pending"}`}><i />{status}</span>
              <button className={ready ? "button primary" : "button secondary"} disabled={!skill.versions.length} onClick={() => onEvaluate(skill)}>
                {skill.versions.length ? <><FlaskConical size={16} />进入评测</> : <>评测包准备中</>}
              </button>
            </div>
          </article>;
        })}
      </div>
    </section>
  </div>;
}


function EvaluationView(props: {
  catalog: Catalog;
  featuredSkill: FeaturedSkill | null;
  selection: string;
  cases: EvalCaseSummary[];
  caseSource: "fixed" | "ai_generated";
  setCaseSource(value: "fixed" | "ai_generated"): void;
  selectedCases: string[];
  setSelectedCases(value: string[]): void;
  runtime: "replay" | "direct_model" | "runtime_http";
  setRuntime(value: "replay" | "direct_model" | "runtime_http"): void;
  directModelAllowed: boolean;
  runtimeEnvironmentId: string;
  setRuntimeEnvironmentId(value: string): void;
  environmentInspection: EnvironmentInspection | null;
  environmentChecking: boolean;
  onInspectEnvironment(): void;
  judgeMode: "deterministic" | "model";
  setJudgeMode(value: "deterministic" | "model"): void;
  leftVariantSelection: string;
  rightVariantSelection: string;
  setLeftVariantSelection(value: string): void;
  setRightVariantSelection(value: string): void;
  leftModelKey: string;
  rightModelKey: string;
  setLeftModelKey(value: string): void;
  setRightModelKey(value: string): void;
  versionOptions: Array<{ version: string; artifactSha256: string | null; packId: string | null }>;
  sameConfiguration: boolean;
  mixedVariables: boolean;
  job: EvaluationJob | null;
  onStart(): void;
  onCancel(): void;
  onRetry(): void;
  canStart: boolean;
  selectedVariantsHaveArtifacts: boolean;
  onBack(): void;
}) {
  const isPreparation = props.selection.startsWith("prep:");
  const target = props.catalog.evalPacks.find(item => `pack:${item.packId}` === props.selection)
    ?? props.catalog.preparations.find(item => `prep:${item.preparationId}` === props.selection);
  const active = props.job && !TERMINAL.has(props.job.status);
  const replayLocked = props.runtime === "replay" || Boolean(active);
  const dynamic = props.caseSource === "ai_generated";
  const questions = dynamic ? props.job?.questionSet?.cases ?? [] : props.cases;
  const runtimeEnvironment = props.catalog.environments.find(item => item.environmentId === props.runtimeEnvironmentId);
  const linkedMcp = runtimeEnvironment&&'mcpEnvironmentIds' in runtimeEnvironment?runtimeEnvironment.mcpEnvironmentIds
    .map(id => props.catalog.environments.find(item => item.environmentId === id))
    .filter((item): item is Environment => Boolean(item)):[];
  const requiredTools = [...new Set((dynamic && questions.length ? questions : props.cases)
    .filter(item => dynamic || props.selectedCases.includes(item.caseId))
    .flatMap(item => item.requiredTools))];
  const targetName = props.featuredSkill?.displayName
    ?? (target && "skillId" in target ? target.skillId : "上传 Skill");
  return (
    <div className="workspace">
      <section className="workspace-header">
        <div><button className="back-link" onClick={props.onBack}><ArrowLeft size={15} />返回精选技能</button><span className="eyebrow">SKILL VALUE COMPARISON</span><h1>{targetName} · 对比评测</h1><p>固定当前 Skill，保持题目与共享环境一致，对比装配方式、版本或模型带来的专业效果差异。</p></div>
        <div className="header-actions">
          {active ? <button className="button secondary danger" onClick={props.onCancel}><CircleStop size={17} />取消</button> : null}
          {!props.catalog.publicDemo && props.job && ["failed", "cancelled", "interrupted"].includes(props.job.status) ? <button className="button secondary" onClick={props.onRetry}><RotateCcw size={17} />单次重试</button> : null}
          <button className="button primary" disabled={!props.canStart} onClick={props.onStart}><Play size={17} />开始测试</button>
        </div>
      </section>

      <section className="fixed-skill-band">
        <div className="fixed-skill-icon"><SkillIcon iconKey={props.featuredSkill?.iconKey ?? "research"} /></div>
        <div><span>固定评测对象</span><strong>{targetName}</strong><small>{props.featuredSkill?.summary ?? (target && "summary" in target ? target.summary : "使用当前测试方案")}</small></div>
        <div className="fixed-skill-meta"><span>{props.versionOptions.length} 个版本</span><span>{dynamic ? "AI 动态出题" : `${props.cases.length} 道回归题`}</span></div>
      </section>

      <section className="shared-environment">
        <div className="shared-environment-title"><div><Network size={18} /><span><strong>统一测试环境</strong><small>Runtime、MCP 和题目由左右两侧共享，避免引入额外变量。</small></span></div>{props.runtime === "runtime_http" ? <button className="button secondary compact" onClick={props.onInspectEnvironment} disabled={props.environmentChecking || !props.runtimeEnvironmentId}><RefreshCw className={props.environmentChecking ? "spin" : ""} size={15} />重新预检</button> : null}</div>
        <div className="environment-controls">
          <label className="field"><span>执行方式</span><select disabled={Boolean(active)} value={props.runtime} onChange={event => props.setRuntime(event.target.value as typeof props.runtime)}>
            {!isPreparation && !props.catalog.publicDemo ? <option value="replay" disabled={!(target && 'replayReady' in target && target.replayReady)}>冻结证据回放{target && 'replayReady' in target && !target.replayReady ? " · 当前评测包未提供" : ""}</option> : null}
            {isPreparation ? <option value="direct_model" disabled={!directExecutionRole(props.catalog).configured || !props.directModelAllowed}>文本 Skill 直测</option> : null}
            <option value="runtime_http">在线 Agent Runtime</option>
          </select></label>
          {props.runtime === "runtime_http" ? <label className="field wide"><span>Agent Runtime</span><select disabled={Boolean(active)} value={props.runtimeEnvironmentId} onChange={event => props.setRuntimeEnvironmentId(event.target.value)}>
            <option value="">请选择</option>
            {props.catalog.environments.filter(item => item.type === "runtime_http").map(item => <option value={item.environmentId} key={item.environmentId}>{item.name} · {runtimeTypeLabel(item.runtimeType)}</option>)}
          </select></label> : null}
          <label className="field"><span>评分方式</span><select disabled={Boolean(active)} value={props.judgeMode} onChange={event => props.setJudgeMode(event.target.value as typeof props.judgeMode)}>
            {!dynamic && !props.catalog.publicDemo && target && 'deterministicReady' in target && target.deterministicReady ? <option value="deterministic">规则量表</option> : null}
            <option value="model" disabled={!props.catalog.modelRoles.judge.configured}>匿名模型 Judge{props.catalog.modelRoles.judge.configured ? ` · ${props.catalog.modelRoles.judge.model.modelId}` : " · 未配置"}</option>
          </select></label>
        </div>
        {props.runtime === "replay" ? <div className="environment-readiness replay"><Archive size={16} /><span><strong>冻结证据已就绪</strong>本轮复核固化的真实或受控输出；左右版本与模型保持锁定。</span></div> : props.runtime === "direct_model" ? <div className="environment-readiness ready"><CircleCheck size={16} /><span><strong>文本执行环境</strong>适用于不依赖工具的上传 Skill，本轮不连接 MCP。</span></div> : <div className={`environment-readiness ${props.environmentChecking ? "checking" : props.environmentInspection?.status ?? "waiting"}`}>
          {props.environmentChecking ? <RefreshCw className="spin" size={16} /> : props.environmentInspection?.status === "ready" ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
          <span><strong>{props.environmentChecking ? "正在自动准备环境" : props.environmentInspection?.status === "ready" ? "在线环境已就绪" : props.environmentInspection?.error ?? "请选择 Agent Runtime"}</strong>{runtimeEnvironment ? `${runtimeTypeLabel(runtimeEnvironment.runtimeType)} · ${linkedMcp.length} 个 MCP 已绑定 · ${props.environmentInspection?.status === 'ready' ? `已发现 ${props.environmentInspection.toolCount} 个工具` : '工具待确认'} · 本轮需要 ${requiredTools.length} 项` : "评测开始前将自动检查 Runtime 与关联 MCP。"}</span>
        </div>}
      </section>

      <div className="comparison-grid">
        <ComparisonConfigurator side="A" title="对照组" selection={props.leftVariantSelection} modelKeyValue={props.leftModelKey} versions={props.versionOptions} models={props.runtime === "direct_model" ? [directExecutionRole(props.catalog).model] : props.catalog.models} locked={replayLocked} onSelectionChange={props.setLeftVariantSelection} onModelChange={props.setLeftModelKey} />
        <div className="comparison-arrow"><ArrowRight size={20} /></div>
        <ComparisonConfigurator side="B" title="目标组" selection={props.rightVariantSelection} modelKeyValue={props.rightModelKey} versions={props.versionOptions} models={props.runtime === "direct_model" ? [directExecutionRole(props.catalog).model] : props.catalog.models} locked={replayLocked} target onSelectionChange={props.setRightVariantSelection} onModelChange={props.setRightModelKey} />
      </div>

      {props.sameConfiguration ? <div className="comparison-warning warning">左右配置完全相同，无法形成有效对比。</div> : props.mixedVariables ? <div className="comparison-warning info">Skill 与模型同时变化，本轮只能说明综合方案差异，不能把提升单独归因于 Skill。</div> : null}
      {props.runtime === "runtime_http" && !props.selectedVariantsHaveArtifacts ? <div className="comparison-warning warning">所选 Skill 版本只有评测定义，本机尚未上传对应实体包；请先到 Skill 资产上传该版本。</div> : null}

      <section className="cases-section">
        <div className="section-title"><div><h2>评测任务</h2></div>{!isPreparation && props.runtime !== "replay" ? <div className="question-mode" role="group" aria-label="题目来源">
          <button aria-pressed={dynamic} disabled={Boolean(active)} onClick={() => { props.setCaseSource("ai_generated"); props.setJudgeMode("model"); }}><Sparkles size={15} />AI 动态出题</button>
          <button aria-pressed={!dynamic} disabled={Boolean(active)} onClick={() => props.setCaseSource("fixed")}><Archive size={15} />固定回归题</button>
        </div> : <span>{props.selectedCases.length}/{props.cases.length} 题</span>}</div>
        {dynamic ? <div className="question-source"><Sparkles size={16} /><span>{props.job?.questionSet ? `本轮 ${questions.length} 题 · ${props.job.questionSet.model.modelId} · 题集 ${props.job.questionSet.fingerprint.slice(0, 12)}` : active ? props.job?.stageLabel : `待开始 · ${props.catalog.modelRoles.analyzer.model.modelId} · 最多 3 题`}</span></div> : null}
        {dynamic && !props.catalog.modelRoles.analyzer.configured ? <div className="run-error">出题模型未配置，请在服务端配置 Analyzer 或选择固定回归题。</div> : null}
        <div className="case-list">
          {questions.map((item, index) => {
            const checked = dynamic || props.selectedCases.includes(item.caseId);
            return <label key={item.caseId} className={checked ? "case-row selected" : "case-row"}>
              {!dynamic ? <input type="checkbox" checked={checked} disabled={Boolean(active)} onChange={() => props.setSelectedCases(checked ? props.selectedCases.filter(id => id !== item.caseId) : [...props.selectedCases, item.caseId])} /> : <span aria-hidden="true"><Sparkles size={14} /></span>}
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

function ComparisonConfigurator(props: {
  side: "A" | "B";
  title: string;
  selection: string;
  modelKeyValue: string;
  versions: Array<{ version: string; artifactSha256: string | null }>;
  models: ModelRef[];
  locked: boolean;
  target?: boolean;
  onSelectionChange(value: string): void;
  onModelChange(value: string): void;
}) {
  const selectedVersion = props.versions.find(item => `version:${item.version}` === props.selection);
  return <section className={props.target ? "comparison-panel target configurable" : "comparison-panel configurable"}>
    <div className="comparison-panel-head"><div className="side-badge">{props.side}</div><div><span>{props.title}</span><strong>对比配置</strong></div>{props.locked ? <small><Archive size={12} />配置已锁定</small> : null}</div>
    <div className="comparison-fields">
      <label className="field"><span>Skill</span><select value={props.selection} disabled={props.locked} onChange={event => props.onSelectionChange(event.target.value)}>
        <option value="without_target_skill">不加载当前 Skill</option>
        {props.versions.map(item => <option key={item.version} value={`version:${item.version}`}>v{item.version}</option>)}
      </select></label>
      <label className="field"><span>模型</span><select value={props.modelKeyValue} disabled={props.locked} onChange={event => props.onModelChange(event.target.value)}>
        {props.models.map(model => <option key={modelKey(model)} value={modelKey(model)} disabled={Boolean(model.availability && model.availability !== "ready")} title={model.statusNote}>{model.label || model.modelId} · {model.providerLabel || model.providerId}{model.availability === "unavailable" ? " · 暂不可用" : model.availability === "unverified" ? " · 待验证" : ""}</option>)}
      </select></label>
    </div>
    <div className="comparison-foot">{selectedVersion ? <span>装配 Skill v{selectedVersion.version}{selectedVersion.artifactSha256 ? <> · SHA <b className="mono">{selectedVersion.artifactSha256.slice(0, 12)}</b></> : null}</span> : <span>不装配当前 Skill；保留相同的 Runtime 与工具环境。</span>}</div>
  </section>;
}

function EmptyRun() {
  return <section className="empty-run"><FlaskConical size={28} /><strong>尚未开始评测</strong></section>;
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
    {job.questionSet ? <details className="question-receipt"><summary>本轮 AI 题集 · {job.questionSet.cases.length} 题 · {job.questionSet.fingerprint.slice(0, 12)}</summary><p>出题模型：{job.questionSet.model.modelId} · 已读取：{job.questionSet.sourceFiles.join("、")}</p>{job.questionSet.cases.map(item => <div key={item.caseId}><strong>{item.name}</strong><MarkdownContent content={item.prompt} /></div>)}</details> : null}
    {job.report ? <ReportResult job={job} /> : <LiveEvidence job={job} />}
  </section>;
}

function LiveEvidence({ job }: { job: EvaluationJob }) {
  const byCase = [...new Set([...job.evidence.map(item => item.caseId), ...Object.values(job.live ?? {}).map(item => item.caseId)])];
  if (!byCase.length) return <div className="live-wait"><RefreshCw className="spin" size={20} />{job.stageLabel}</div>;
  return <div className="live-cases">{byCase.map(caseId => <div className="live-case" key={caseId}><h3>{caseId}</h3><div className="answer-grid">{(["left", "right"] as const).map(side => {
    const evidence = job.evidence.find(item => item.caseId === caseId && item.side === side);
    const live = job.live?.[`${caseId}:${side}`];
    return <article key={side}><span>{side === "left" ? "A · 对照组" : "B · 目标组"}</span><small className="live-state">{evidence ? evidence.status === "completed" ? "执行完成" : "执行失败" : live?.status ?? "等待执行"}</small>
      <div className="tool-events">{(evidence?.toolCalls ?? live?.toolCalls ?? []).map((tool,i) => <span key={`${tool.name}-${i}`} className={tool.status}>{tool.status === "running" ? <RefreshCw className="spin" size={12} /> : null}{tool.name} · {tool.status}</span>)}</div>
      <MarkdownContent streaming={!evidence && !TERMINAL.has(job.status)} content={evidence?.output || evidence?.error || live?.output || "等待模型输出"} /></article>;
  })}</div></div>)}</div>;
}

function ReportResult({ job }: { job: EvaluationJob }) {
  const publicDemo = useContext(PublicDemoContext);
  const report = job.report!;
  return <div className="report-result">
    {report.cases.some(c => c.right.metadata?.dataMode?.includes("synthetic")) ? <div className="evidence-notice">数据来源：只读模拟业务快照；模型与 MCP 工具本轮实际执行，不代表真实客户业务验收。</div> : null}
    <div className="score-strip">
      <div><span>A 胜</span><strong>{report.summary.leftWins}</strong></div><div className="winner-metric"><span>B 胜</span><strong>{report.summary.rightWins}</strong></div><div><span>持平</span><strong>{report.summary.ties}</strong></div><div><span>平均耗时</span><strong>{Math.round((report.summary.meanElapsedMs.left + report.summary.meanElapsedMs.right) / 2000)}s</strong></div>
      <div className="report-downloads">{(['html','json'] as const).map(format=><button className="button secondary" key={format} onClick={()=>void downloadApi(`/api/runs/${job.jobId}/export?format=${format}`,`${job.jobId}.${format}`).catch(error=>window.alert(error.message))}><Download size={15}/>{format.toUpperCase()}</button>)}</div>
    </div>
    <ResultCharts report={report} />
    {report.cases.map(item => <section className="result-case" key={item.caseId}>
      <header><div><span>{item.caseId}</span><h3>{item.name}</h3></div><strong className={`winner winner-${item.judge?.winner ?? "none"}`}>{item.judge?.winner === "right" ? "B 更优" : item.judge?.winner === "left" ? "A 更优" : item.judge ? "持平" : "未评阅"}</strong></header>
      <div className="answer-grid"><article><span>A · {item.left.skillVersion ? `v${item.left.skillVersion}` : '不装配当前 Skill'} · {item.left.modelId}</span><MarkdownContent content={item.left.output} /></article><article><span>B · {item.right.skillVersion ? `v${item.right.skillVersion}` : '不装配当前 Skill'} · {item.right.modelId}</span><MarkdownContent content={item.right.output} /></article></div>
      <div className="judge-summary"><Sparkles size={17} /><div><strong>金融专业评价</strong><MarkdownContent compact content={item.judge?.summary ?? item.judgeError ?? "未形成评价"} />{item.judge ? <div className="dimension-grid">{item.judge.dimensions.map(dimension => <div key={dimension.id}><span>{dimension.label}</span><b>{dimension.leftScore} / {dimension.rightScore}</b><small>{dimension.reason}</small></div>)}</div> : null}</div></div>
    </section>)}
    {!publicDemo && job.configuration.runtime.type === "runtime_http" && job.status === "completed" ? <OptimizationPanel key={job.jobId} job={job} /> : null}
    <footer className="report-footer"><span>Runtime: {report.runtimeAdapterId}</span><span>Judge: {report.judgeId}</span><span className="mono">报告 {report.reportFingerprint.slice(0, 16)}</span></footer>
  </div>;
}

function MigrationWorkspace({catalog,source,onChanged}:{catalog:Catalog;source:SkillAsset|null;onChanged():Promise<void>}) {
  const [uploadedAsset,setUploadedAsset]=useState(source),[error,setError]=useState(''),[uploading,setUploading]=useState(false);
  const [imports,setImports]=useState<ImportResult[]>([]),[refreshKey,setRefreshKey]=useState(0);
  const input=useRef<HTMLInputElement>(null);
  async function upload(files:File[]){if(uploading)return;setUploading(true);setError('');setImports([]);let single:SkillAsset|null=null;try{
    const results=await importMigrationFiles(files,async(bytes)=>{
      const asset=await api<SkillAsset>('/api/migrations/upload',{method:'POST',body:new Blob([bytes as BlobPart]),headers:{'content-type':'application/zip'}});
      // Single uploads are opened and created by MigrationPanel. Batch uploads remain in
      // the project list, so create one project per successful file here.
      if(files.length>1)await api('/api/migrations',{method:'POST',body:JSON.stringify({sourceAssetId:asset.assetId,name:`${asset.displayName} 迁移`})});
      single=asset;
    });setImports(results);await onChanged();setUploadedAsset(files.length===1?single:null);setRefreshKey(n=>n+1);
  }catch(e){setError(String(e));}finally{setUploading(false);}}
  return <div className="workspace"><section className="workspace-header"><div><span className="eyebrow">SKILL MIGRATION</span><h1>Skill 迁移</h1></div></section>
    {error&&<p role="alert">{error}</p>}{uploading&&<p role="status">上传中</p>}
    {imports.length>0&&<ul aria-label="导入结果">{imports.map((r,i)=><li key={i}>{r.name}：{r.status==='IMPORTED'?'已导入':r.error}</li>)}</ul>}
    <input hidden ref={input} type="file" multiple accept=".zip,.md,application/zip,text/markdown" onChange={e=>{const files=Array.from(e.target.files??[]);if(files.length)void upload(files);e.target.value='';}}/>
    <MigrationPanel catalog={catalog} api={api} uploadedAsset={uploadedAsset} refreshKey={refreshKey} onUpload={()=>{if(!uploading)input.current?.click();}}/>
  </div>;
}

function SkillAssetsView({ catalog, onChanged, onSelectPreparation,onMigrate }: { catalog: Catalog; onChanged(): Promise<void>; onSelectPreparation(id: string): void;onMigrate(asset:SkillAsset):void }) {
  const [uploading, setUploading] = useState(false);
  const [preparing, setPreparing] = useState("");
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const upload = async (file: File) => {
    setUploading(true); setMessage("");
    try {
      const asset=await api<SkillAsset>("/api/skills/upload", { method: "POST", body: file, headers: { "content-type": "application/zip" } });
      await onChanged(); setMessage("Skill 已上传，可发起迁移或生成评测试题。");
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
        return <div className="asset-row" key={skill.assetId}><div className="asset-icon"><FileArchive size={20} /></div><div><strong>{skill.displayName}</strong><small>{skill.skillId}@{skill.version} · {skill.fileCount} 个文件</small><p>{skill.description}</p><em className="mono">SHA {skill.artifactSha256.slice(0, 16)}</em></div><div className="asset-actions"><button className="button secondary" onClick={()=>onMigrate(skill)}><ArrowRightLeft size={16}/>发起迁移</button><button className="button secondary" onClick={() => prepare(skill.assetId)} disabled={preparing === skill.assetId || !catalog.modelRoles.analyzer.configured}><Sparkles size={16} />{preparing === skill.assetId ? "出题中" : "AI 生成试题"}</button>{preps[0] ? <button className="icon-button" title="进入评测" onClick={() => onSelectPreparation(preps[0].preparationId)}><ChevronRight size={18} /></button> : null}</div></div>;
      }) : <div className="empty-table">尚未上传 Skill ZIP</div>}</div>
    </section>
    <section className="asset-section"><div className="section-title"><div><h2>预制 Eval Pack</h2><p>由金融 SOP、Golden Cases 与 Judge Rubric 共同定义。</p></div><span>{catalog.evalPacks.length} 套</span></div><div className="asset-table">{catalog.evalPacks.map(pack => <div className="asset-row" key={pack.packId}><div className="asset-icon"><Archive size={20} /></div><div><strong>{pack.targetSkillId}</strong><small>v{pack.targetSkillVersion} · {pack.caseCount} 题 · {pack.domain}</small><p>{pack.description}</p><em className="mono">PACK {pack.fingerprint.slice(0, 16)}</em></div><span className={pack.replayReady ? "state-tag ready" : "state-tag"}>{pack.replayReady ? "可回放" : "需在线 Runtime"}</span></div>)}</div></section>
  </div>;
}


function HistoryView({ jobs, selected, onSelect, onRetry }: { jobs: EvaluationJob[]; selected: EvaluationJob | null; onSelect(job: EvaluationJob): void; onRetry(job: EvaluationJob): void }) {
  const current = selected ?? jobs[0] ?? null;
  return <div className="workspace"><section className="workspace-header"><div><span className="eyebrow">RUN HISTORY</span><h1>真实运行记录</h1><p>保留运行配置、左右证据、失败原因和可导出报告。</p></div></section><div className="history-layout"><div className="history-list">{jobs.map(job => <button key={job.jobId} className={current?.jobId === job.jobId ? "history-item active" : "history-item"} onClick={() => onSelect(job)}><div><strong>{job.pack?.targetSkillId ?? "准备中"}</strong><span className={`run-status ${job.status}`}>{statusText(job.status)}</span></div><small>{formatTime(job.updatedAt)} · {job.pack?.caseCount ?? 0} 题</small><p>{job.report?.summary.headline ?? job.error?.message ?? job.stageLabel}</p></button>)}</div><div>{current ? <><RunEvidence job={current} />{["failed", "cancelled", "interrupted"].includes(current.status) ? <button className="button secondary history-retry" onClick={() => onRetry(current)}><RotateCcw size={16} />重试这一轮</button> : null}</> : <EmptyRun />}</div></div></div>;
}
