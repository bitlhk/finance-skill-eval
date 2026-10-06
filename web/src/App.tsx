import { api } from "./api-client";
import {evidenceLabels} from '../../src/evidence-labels';
import {selectedVersion,versionSelectionKey} from './skill-version-selection';
import {matchEnvironments,chooseEnvironment,inspectionIssues,type EnvironmentMatch} from './environment-matching';
import {dualRuntimeConfiguration} from './dual-runtime-configuration';
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
import {RuntimeGoalResults, runtimeGoalCounts} from './RuntimeGoalResults';
import { OptimizationPanel } from "./OptimizationPanel";
import { MigrationPanel } from './MigrationPanel';
import type {
  SkillAsset,
  Evidence,
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
type ExecutionMode = "replay" | "direct_model" | "runtime_launcher" | "dual_runtime";
type ComparisonMode = 'skill'|'model'|'runtime';
type LauncherPair = {left:string;right:string};
type Generation = {temperature:number;top_p:number;max_tokens:number;thinking?:{type:'disabled'}};

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const PublicDemoContext = createContext(false);



function statusText(status: EvaluationJob["status"]): string {
  return ({
    queued: "排队中",
    preparing: "准备中",
    running: "执行中",
    judging: "评阅中",
    completed: "评测完成",
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
  return variant.mode === "without_target_skill" ? "without_target_skill" : versionSelectionKey(variant);
}

function runtimeTypeLabel(value: Environment["runtimeType"]): string {
  if (value === "openjiuwen") return "OpenJiuwen";
  if (value === "agentscope") return "AgentScope Java";
  if (value === "ea") return "EA Runtime";
  return "通用 HTTP Runtime";
}

export function App() {
  const [needsAccess, setNeedsAccess] = useState(false);
  const [accessInput, setAccessInput] = useState("");
  const [view, setView] = useState<View>("catalog");
  const [migrationSource,setMigrationSource]=useState<SkillAsset|null>(null);
  const [focusedAsset,setFocusedAsset]=useState<string|null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [selection, setSelection] = useState("");
  const [selectedCases, setSelectedCases] = useState<string[]>([]);
  const [includeHoldout, setIncludeHoldout] = useState(false);
  const [caseSource, setCaseSource] = useState<"fixed" | "ai_generated">("ai_generated");
  const [leftVariantSelection, setLeftVariantSelection] = useState("without_target_skill");
  const [rightVariantSelection, setRightVariantSelection] = useState("");
  const [leftModelKey, setLeftModelKey] = useState("");
  const [rightModelKey, setRightModelKey] = useState("");
  const [runtime, setRuntime] = useState<ExecutionMode>("runtime_launcher");
  const [comparisonMode,setComparisonMode]=useState<ComparisonMode>('skill');
  const [runtimeFamily,setRuntimeFamily]=useState<NonNullable<Environment['runtimeType']>>('openjiuwen');
  const [launcherPair,setLauncherPair]=useState<LauncherPair>({left:"",right:""});
  const [launcherReady,setLauncherReady]=useState(false);
  const [launcherStatus,setLauncherStatus]=useState("");
  const [generation,setGeneration]=useState<Generation>({temperature:0,top_p:1,max_tokens:2000});
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
  const holdoutEnabled = runtime === 'dual_runtime' && !dynamicQuestions && Boolean(selectedPack?.holdoutCaseCount);
  const useHoldout = holdoutEnabled && includeHoldout;
  const selectedUploadedSkill = selectedPreparation
    ? catalog?.uploadedSkills.find(item => item.assetId === selectedPreparation.skillAssetId) ?? null
    : null;
  const preparationRequiresTools = Boolean(selectedUploadedSkill?.runtimeRequirements?.tools.length || selectedPreparation?.cases.some(item => item.requiredTools.length > 0));
  const selectedFeaturedSkill = catalog?.featuredSkills.find(item => item.skillId === selectedSkillId) ?? null;
  const selectedMethodAssets=(catalog?.uploadedSkills??[]).filter(asset=>asset.skillId===(selectedPack?.targetSkillId??selectedPreparation?.skillId)&&
    [leftVariantSelection,rightVariantSelection].some(value=>selectedVersion(value,[asset])?.artifactSha256===asset.artifactSha256));
  const declarationIssue=selectedMethodAssets.find(asset=>asset.runtimeRequirements?.status==='invalid')?.runtimeRequirements?.error;
  const canAutoMatch=selectedMethodAssets.length>0&&selectedMethodAssets.every(asset=>asset.runtimeRequirements?.status==='declared');
  const requiredLauncherTools=[...new Set([...(selectedPack?selectedFeaturedSkill?.requiredTools??[]:[]),
    ...selectedMethodAssets.flatMap(asset=>asset.runtimeRequirements?.tools??[]),
    ...cases.filter(c=>selectedCases.includes(c.caseId)).flatMap(c=>c.requiredTools),
    ...(useHoldout?selectedPack?.holdoutRequiredTools??[]:[])])].sort();
  const requiredLauncherToolsKey=JSON.stringify(requiredLauncherTools);
  const environmentMatches=matchEnvironments(catalog?.executionRuntimes??[],requiredLauncherTools);
  const matchesKey=JSON.stringify(environmentMatches.map(item=>[item.runtime.runtimeId,item.runtime.runtimeType,item.issues]));
  useEffect(()=>{
    if(!canAutoMatch||activeJob&&!TERMINAL.has(activeJob.status))return;
    setRuntimeEnvironmentId(current=>chooseEnvironment(environmentMatches,runtimeFamily,current));
    setLauncherPair(current=>({
      left:chooseEnvironment(environmentMatches,'openjiuwen',current.left),
      right:chooseEnvironment(environmentMatches,'agentscope',current.right),
    }));
  },[matchesKey,canAutoMatch,runtimeFamily,selection,activeJob?.status]);
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
  ].map(item => [versionSelectionKey(item), item])).values()];
  const initializedSelection = useRef("");
  useEffect(() => {
    if ((!selectedPack && !selectedPreparation) || initializedSelection.current === selection) return;
    initializedSelection.current = selection;
    setComparisonMode('skill');
    setSelectedCases(cases.map(item => item.caseId));
    setIncludeHoldout(false);
    if (selectedPack) {
      setRuntime("runtime_launcher");
      setJudgeMode(catalog?.modelRoles.judge.configured ? "model" : "deterministic");
      setLeftVariantSelection(variantSelection(selectedPack.variants.left));
      setRightVariantSelection(variantSelection(selectedPack.variants.right));
      setLeftModelKey(modelKey(catalog?.modelRoles.execution.configured ? catalog.modelRoles.execution.model : selectedPack.models.execution.left));
      setRightModelKey(modelKey(catalog?.modelRoles.execution.configured ? catalog.modelRoles.execution.model : selectedPack.models.execution.right));
    }
    if (selectedPreparation) {
      setRuntime("runtime_launcher");
      setLeftVariantSelection("without_target_skill");
      setRightVariantSelection(versionSelectionKey(selectedUploadedSkill??{version:selectedPreparation.skillVersion}));
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

  useEffect(()=>{
    if(runtime!=='runtime_launcher'||!catalog)return;
    const option=catalog.executionRuntimes.find(item=>item.runtimeId===runtimeEnvironmentId);
    if(!option)return;
    if(option.runtimeId!==runtimeEnvironmentId)setRuntimeEnvironmentId(option.runtimeId);
    const preferred=option.models.find(model=>model.modelId===option.defaultModelId)??option.models[0];
    if(preferred){
      const keys=new Set(option.models.map(modelKey));
      setLeftModelKey(current=>keys.has(current)?current:modelKey(preferred));
      setRightModelKey(current=>keys.has(current)?current:modelKey(preferred));
    }
  },[runtime,runtimeEnvironmentId,catalog]);

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
      if(inspection.status==='ready'&&inspection.capabilities){
        const issues=inspectionIssues(inspection,requiredLauncherTools);
        if(issues.length){inspection.status='failed';inspection.error=issues.join('；');}
      }
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
    if (runtime !== 'runtime_launcher' || !runtimeEnvironmentId) {
      setEnvironmentInspection(null);
      return;
    }
    void inspectEnvironment(runtimeEnvironmentId);
  }, [runtime, runtimeEnvironmentId, selection, requiredLauncherToolsKey]);

  useEffect(()=>{
    let current=true;
    setLauncherReady(false);
    if(runtime!=="dual_runtime"||!launcherPair.left||!launcherPair.right){setLauncherStatus("请选择两个评测环境");return;}
    setLauncherStatus("正在核对两侧环境");
    Promise.all([launcherPair.left,launcherPair.right].map(id=>api<EnvironmentInspection>(`/api/environments/${id}/preflight`,{method:"POST"})))
      .then(results=>{if(!current)return;for(const result of results){if(result.status==='ready'){
        const issues=inspectionIssues(result,requiredLauncherTools);
        if(issues.length){result.status='failed';result.error=issues.join('；');}
      }}const ready=results.every(result=>result.status==="ready");setLauncherReady(ready);
        setLauncherStatus(ready?results.map(result=>`${result.capabilities?.runtime.type??"未知"} ${result.capabilities?.runtime.version??""}`).join(" / "):results.filter(result=>result.status!=="ready").map(result=>result.error||"预检失败").join("；"));})
      .catch(cause=>{if(current)setLauncherStatus(String(cause));});
    return ()=>{current=false;};
  },[runtime,launcherPair.left,launcherPair.right,requiredLauncherToolsKey]);

  useEffect(()=>{
    if(runtime!=="dual_runtime"||!catalog)return;
    const left=catalog.executionRuntimes.find(item=>item.runtimeId===launcherPair.left);
    const right=catalog.executionRuntimes.find(item=>item.runtimeId===launcherPair.right);
    const common=(left?.models??[]).filter(model=>right?.models.some(candidate=>
      candidate.modelId===model.modelId&&(!model.upstreamModelId||!candidate.upstreamModelId||candidate.upstreamModelId===model.upstreamModelId)));
    const preferred=common.find(model=>model.modelId===left?.defaultModelId)??common[0];
    if(!preferred)return;
    const key=modelKey(preferred);
    setLeftModelKey(key);
    setRightModelKey(key);
  },[runtime,launcherPair.left,launcherPair.right,catalog]);

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

  const selectedRuntimeOption=catalog?.executionRuntimes.find(item=>item.runtimeId===runtimeEnvironmentId);
  const leftRuntimeOption=catalog?.executionRuntimes.find(item=>item.runtimeId===launcherPair.left);
  const rightRuntimeOption=catalog?.executionRuntimes.find(item=>item.runtimeId===launcherPair.right);
  const pairedRuntimeModels=(leftRuntimeOption?.models??[]).filter(left=>rightRuntimeOption?.models.some(right=>
    right.modelId===left.modelId&&(!left.upstreamModelId||!right.upstreamModelId||right.upstreamModelId===left.upstreamModelId)));
  const runtimeModels=runtime==='dual_runtime'?pairedRuntimeModels:runtime==='runtime_launcher'?(selectedRuntimeOption?.models??[]):[];
  const runtimeDefaultModel=runtime==='dual_runtime'
    ? pairedRuntimeModels.find(item=>item.modelId===leftRuntimeOption?.defaultModelId)??pairedRuntimeModels[0]
    : selectedRuntimeOption?.models.find(item=>item.modelId===selectedRuntimeOption.defaultModelId)??selectedRuntimeOption?.models[0];
  const selectedLeftModel = runtime === "direct_model" && catalog ? directExecutionRole(catalog).model : runtimeModels.find(item => modelKey(item) === leftModelKey)
    ?? (runtime==='runtime_launcher'||runtime==='dual_runtime'?runtimeDefaultModel:undefined)
    ?? selectedPack?.models.execution.left
    ?? catalog?.modelRoles.execution.model;
  const selectedRightModel = runtime === "direct_model" && catalog ? directExecutionRole(catalog).model : runtimeModels.find(item => modelKey(item) === rightModelKey)
    ?? (runtime==='runtime_launcher'||runtime==='dual_runtime'?runtimeDefaultModel:undefined)
    ?? selectedPack?.models.execution.right
    ?? catalog?.modelRoles.execution.model;
  const resolveVariant = (value: string): SkillVariant => {
    if (value === "without_target_skill") return { mode: "without_target_skill", skillId: targetSkillId };
    const option = selectedVersion(value,versionOptions);
    if(!option)throw new Error("所选 Skill 版本无法唯一确定，请重新选择具体产物");
    const version = option.version;
    return {
      mode: "skill_version",
      skillId: targetSkillId,
      version,
      ...(option?.artifactSha256 ? { artifactSha256: option.artifactSha256 } : {}),
    };
  };
  const sameConfiguration = leftVariantSelection === rightVariantSelection && leftModelKey === rightModelKey
    && (runtime!=="dual_runtime"||launcherPair.left===launcherPair.right);
  const mixedVariables = leftVariantSelection !== rightVariantSelection && leftModelKey !== rightModelKey;
  const selectedVariantsHaveArtifacts = [leftVariantSelection, rightVariantSelection].every(value => {
    if (value === "without_target_skill") return true;
    const option = selectedVersion(value,versionOptions);
    return Boolean(option && catalog?.uploadedSkills.some(asset =>
      asset.skillId === targetSkillId
      && asset.version === option.version
      && (!option.artifactSha256 || asset.artifactSha256 === option.artifactSha256),
    ));
  });
  const changeRightVariant = (value: string) => {
    setRightVariantSelection(value);
    if(runtime==='dual_runtime'||comparisonMode==='model')setLeftVariantSelection(value);
  };

  const changeComparison=(mode:ComparisonMode)=>{
    setComparisonMode(mode);
    if(mode==='runtime'){
      setRuntime('dual_runtime');setCaseSource('fixed');setJudgeMode('model');
      setLeftVariantSelection(rightVariantSelection);setRightModelKey(leftModelKey);
    }else{
      if(runtime==='dual_runtime')setRuntime('runtime_launcher');
      if(mode==='model')setLeftVariantSelection(rightVariantSelection);
      else {setRightModelKey(leftModelKey);setLeftVariantSelection('without_target_skill');}
    }
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
      const dualRuntime=runtime==="dual_runtime";
      const boundAsset=(value:string)=>selectedVersion(value,catalog?.uploadedSkills.filter(item=>item.skillId===targetSkillId)??[]);
      const leftAsset=boundAsset(leftVariantSelection),rightAsset=boundAsset(rightVariantSelection);
      if(dualRuntime&&(!leftAsset||!rightAsset||leftAsset.assetId!==rightAsset.assetId||!selectedLeftModel||leftModelKey!==rightModelKey))throw Error("双 Runtime 评测需要同一份已导入 Skill 和相同模型");
      const job = await api<EvaluationJob>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          ...(selectedPack ? { packId: selectedPack.packId } : { preparationId: selectedPreparation!.preparationId }),
          runtime: dualRuntime
            ? {type:"runtime_launcher",environmentId:launcherPair.left}
            : runtime === "runtime_launcher"
              ? { type: runtime, environmentId: runtimeEnvironmentId }
            : { type: runtime },
          judgeMode,
          leftVariant: resolveVariant(leftVariantSelection),
          rightVariant: resolveVariant(rightVariantSelection),
          ...(dualRuntime ? {...dualRuntimeConfiguration(executionReference(selectedLeftModel!),generation),
            runtimeBindings:{left:{environmentId:launcherPair.left,skillAssetId:leftAsset!.assetId},right:{environmentId:launcherPair.right,skillAssetId:rightAsset!.assetId}}}
            : {...(selectedLeftModel ? { leftExecutionModel: executionReference(selectedLeftModel) } : {}),
               ...(selectedRightModel ? { rightExecutionModel: executionReference(selectedRightModel) } : {})}),
          caseSource: dynamicQuestions ? "ai_generated" : "fixed",
          selectedCaseIds: dynamicQuestions ? [] : selectedCases,
          includeHoldout: useHoldout,
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
    !declarationIssue
    && (comparisonMode!=='skill'||leftModelKey===rightModelKey)
    && (comparisonMode!=='model'||leftVariantSelection===rightVariantSelection)
    && (comparisonMode!=='model'||leftModelKey!==rightModelKey)
    && selection && (dynamicQuestions ? catalog?.modelRoles.analyzer.configured && judgeMode === "model" : selectedCases.length && selectedCases.every(id=>cases.some(c=>c.caseId===id)))
    && !environmentChecking
    && (runtime !== "replay" || Boolean(selectedPack?.replayReady))
    && (runtime === "replay" || [selectedLeftModel, selectedRightModel].every(m => m && (!m.availability || m.availability === "ready")))
    && (runtime !== 'runtime_launcher' || selectedVariantsHaveArtifacts)
    && (runtime !== 'runtime_launcher' || runtimeEnvironmentId)
    && (runtime !== 'runtime_launcher' || environmentMatches.some(item=>item.runtime.runtimeId===runtimeEnvironmentId&&!item.issues.length))
    && (runtime !== 'dual_runtime' || [launcherPair.left,launcherPair.right].every(id=>environmentMatches.some(item=>item.runtime.runtimeId===id&&!item.issues.length)))
    && (runtime !== 'runtime_launcher' || environmentInspection?.status === "ready")
    && (runtime!=="dual_runtime" || launcherReady && !dynamicQuestions && leftModelKey===rightModelKey && leftVariantSelection===rightVariantSelection && judgeMode==='model'
      && [leftVariantSelection,rightVariantSelection].every(value=>selectedVersion(value,catalog?.uploadedSkills.filter(item=>item.skillId===targetSkillId)??[]))
      && Number.isFinite(generation.temperature)&&generation.temperature>=0&&generation.temperature<=2
      && Number.isFinite(generation.top_p)&&generation.top_p>0&&generation.top_p<=1
      && Number.isInteger(generation.max_tokens)&&generation.max_tokens>=1&&generation.max_tokens<=32768)
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
            holdoutCaseCount={holdoutEnabled ? selectedPack?.holdoutCaseCount ?? 0 : 0}
            includeHoldout={useHoldout}
            setIncludeHoldout={setIncludeHoldout}
            runtime={runtime}
            comparisonMode={comparisonMode} onComparisonChange={changeComparison}
            environmentMatches={environmentMatches} canAutoMatch={canAutoMatch} declarationIssue={declarationIssue}
            requiredLauncherTools={requiredLauncherTools}
            runtimeFamily={runtimeFamily} setRuntimeFamily={setRuntimeFamily}
            setRuntime={value=>{if(value==='dual_runtime')changeComparison('runtime');else {setRuntime(value);if(comparisonMode==='runtime')setComparisonMode('skill');}}}
            launcherPair={launcherPair} setLauncherPair={setLauncherPair} launcherStatus={launcherStatus}
            generation={generation} setGeneration={setGeneration}
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
            setLeftVariantSelection={value=>{setLeftVariantSelection(value);if(runtime==='dual_runtime'||comparisonMode==='model')setRightVariantSelection(value);}}
            setRightVariantSelection={changeRightVariant}
            leftModelKey={leftModelKey}
            rightModelKey={rightModelKey}
            setLeftModelKey={value=>{setLeftModelKey(value);if(runtime==='dual_runtime'||comparisonMode==='skill')setRightModelKey(value);}}
            setRightModelKey={value=>{setRightModelKey(value);if(runtime==='dual_runtime'||comparisonMode==='skill')setLeftModelKey(value);}}
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
        {view === "migration" && catalog?.publicDemo===false ? <MigrationWorkspace catalog={catalog} source={migrationSource} onChanged={refresh} onUseAsset={async asset=>{await refresh();setFocusedAsset(asset.assetId);setView('skills');}}/> : null}
        {view === "skills" && catalog ? <SkillAssetsView catalog={catalog} focusedAsset={focusedAsset} onChanged={refresh} onMigrate={asset=>{setMigrationSource(asset);setView('migration');}} onSelectPreparation={id => {
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
  comparisonMode:ComparisonMode;
  onComparisonChange(mode:ComparisonMode):void;
  environmentMatches:EnvironmentMatch[];
  canAutoMatch:boolean;
  declarationIssue?:string;
  requiredLauncherTools:string[];
  runtimeFamily:NonNullable<Environment['runtimeType']>;
  setRuntimeFamily(value:NonNullable<Environment['runtimeType']>):void;
  catalog: Catalog;
  featuredSkill: FeaturedSkill | null;
  selection: string;
  cases: EvalCaseSummary[];
  caseSource: "fixed" | "ai_generated";
  setCaseSource(value: "fixed" | "ai_generated"): void;
  selectedCases: string[];
  setSelectedCases(value: string[]): void;
  holdoutCaseCount: number;
  includeHoldout: boolean;
  setIncludeHoldout(value: boolean): void;
  runtime: ExecutionMode;
  setRuntime(value: ExecutionMode): void;
  launcherPair:LauncherPair;
  setLauncherPair(value:LauncherPair):void;
  launcherStatus:string;
  generation:Generation;
  setGeneration(value:Generation):void;
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
  const runtimeOption=props.catalog.executionRuntimes.find(item=>item.runtimeId===props.runtimeEnvironmentId);
  const leftRuntimeOption=props.catalog.executionRuntimes.find(item=>item.runtimeId===props.launcherPair.left);
  const rightRuntimeOption=props.catalog.executionRuntimes.find(item=>item.runtimeId===props.launcherPair.right);
  const pairedRuntimeModels=(leftRuntimeOption?.models??[]).filter(left=>rightRuntimeOption?.models.some(right=>
    right.modelId===left.modelId&&(!left.upstreamModelId||!right.upstreamModelId||right.upstreamModelId===left.upstreamModelId)));
  const linkedMcp = runtimeEnvironment&&'mcpEnvironmentIds' in runtimeEnvironment?runtimeEnvironment.mcpEnvironmentIds
    .map(id => props.catalog.environments.find(item => item.environmentId === id))
    .filter((item): item is Environment => Boolean(item)):[];
  const requiredTools = [...new Set([...props.requiredLauncherTools,...(dynamic && questions.length ? questions : props.cases)
    .filter(item => dynamic || props.selectedCases.includes(item.caseId))
    .flatMap(item => item.requiredTools)])];
  const targetName = props.featuredSkill?.displayName
    ?? (target && "skillId" in target ? target.skillId : "上传 Skill");
  const comparisonModels=props.runtime === 'direct_model'
    ? [directExecutionRole(props.catalog).model]
    : props.runtime === 'dual_runtime'
      ? pairedRuntimeModels
    : props.runtime === 'runtime_launcher'
      ? runtimeOption?.models??[]
      : target && 'models' in target
        ? [target.models.execution.left,target.models.execution.right].filter((model,index,all)=>all.findIndex(item=>modelKey(item)===modelKey(model))===index)
        : [];
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
        <div className="comparison-modes" role="group" aria-label="对比目标">
          {([['skill','对比 Skill'],['model','对比模型'],['runtime','对比 Runtime']] as const).map(([mode,label])=><button key={mode} type="button" aria-pressed={props.comparisonMode===mode} disabled={Boolean(active)||(mode==='runtime'&&Boolean(props.catalog.publicDemo))} onClick={()=>props.onComparisonChange(mode)}>{label}</button>)}
        </div>
        {props.declarationIssue?<p role="alert" className="comparison-warning warning">{props.declarationIssue}</p>:null}
        <div className="environment-match-summary" role="status">
          <span>{props.canAutoMatch?'按 Skill 工具声明匹配':'工具声明不完整，请核对环境依赖'}</span>
          <strong>{props.environmentMatches.filter(item=>!item.issues.length).length} 个可用环境</strong>
        </div>
        <div className="shared-environment-title"><div><Network size={18} /><span><strong>测试环境</strong><small>{props.runtime==='dual_runtime'?'左右两侧使用独立 Runtime，Skill、模型和题目保持一致。':'Runtime、MCP 和题目由左右两侧共享，避免引入额外变量。'}</small></span></div>{props.runtime === 'runtime_launcher' ? <button className="button secondary compact" onClick={props.onInspectEnvironment} disabled={props.environmentChecking || !props.runtimeEnvironmentId}><RefreshCw className={props.environmentChecking ? "spin" : ""} size={15} />重新预检</button> : null}</div>
        <div className="environment-controls">
          {props.runtime==='runtime_launcher'?<label className="field"><span>运行框架</span><select aria-label="运行框架" value={props.runtimeFamily} disabled={Boolean(active)} onChange={event=>props.setRuntimeFamily(event.target.value as NonNullable<Environment['runtimeType']>)}>
            {[...new Set(props.catalog.executionRuntimes.map(item=>item.runtimeType))].map(family=><option key={family} value={family}>{runtimeTypeLabel(family)}</option>)}
          </select></label>:null}
          <label className="field"><span>执行方式</span><select disabled={Boolean(active)} value={props.runtime} onChange={event => props.setRuntime(event.target.value as typeof props.runtime)}>
            {!isPreparation && !props.catalog.publicDemo ? <option value="replay" disabled={!(target && 'replayReady' in target && target.replayReady)}>冻结证据回放{target && 'replayReady' in target && !target.replayReady ? " · 当前评测包未提供" : ""}</option> : null}
            {isPreparation ? <option value="direct_model" disabled={!directExecutionRole(props.catalog).configured || !props.directModelAllowed}>文本 Skill 直测</option> : null}
            <option value="runtime_launcher" disabled={!props.catalog.executionRuntimes.length}>在线执行环境</option>
            {!props.catalog.publicDemo&&props.catalog.executionRuntimes.length?<option value="dual_runtime">双 Runtime 临时实例</option>:null}
          </select></label>
          {props.runtime === "runtime_launcher" ? <label className="field wide"><span>执行环境</span><select aria-label="执行环境" disabled={Boolean(active)} value={props.runtimeEnvironmentId} onChange={event => props.setRuntimeEnvironmentId(event.target.value)}>
            <option value="">请选择</option>
            {props.environmentMatches.filter(match=>match.runtime.runtimeType===props.runtimeFamily).map(({runtime:item,issues}) => <option disabled={issues.length>0} value={item.runtimeId} key={item.runtimeId}>{item.name}{issues.length?` · ${issues.join('；')}`:''}</option>)}
          </select></label> : null}
          <label className="field"><span>评分方式</span><select disabled={Boolean(active)||props.runtime==='dual_runtime'} value={props.judgeMode} onChange={event => props.setJudgeMode(event.target.value as typeof props.judgeMode)}>
            {!dynamic && !props.catalog.publicDemo && target && 'deterministicReady' in target && target.deterministicReady ? <option value="deterministic">规则量表</option> : null}
            <option value="model" disabled={!props.catalog.modelRoles.judge.configured}>匿名模型 Judge{props.catalog.modelRoles.judge.configured ? ` · ${props.catalog.modelRoles.judge.model.modelId}` : " · 未配置"}</option>
          </select></label>
        </div>
        {props.runtime==="dual_runtime"?<><div className="environment-controls">
          {(["left","right"] as const).map((side,index)=><label className="field" key={side}><span>{index===0?"对照组 Runtime":"目标组 Runtime"}</span><select aria-label={index===0?'对照组 Runtime':'目标组 Runtime'} disabled={Boolean(active)} value={props.launcherPair[side]} onChange={event=>props.setLauncherPair({...props.launcherPair,[side]:event.target.value})}><option value="">请选择兼容环境</option>{props.environmentMatches.map(({runtime:item,issues})=><option disabled={issues.length>0} key={item.runtimeId} value={item.runtimeId}>{item.name}{issues.length?` · ${issues.join('；')}`:''}</option>)}</select></label>)}
          {(["temperature","top_p","max_tokens"] as const).map(name=><label className="field" key={name}><span>{name}</span><input type="number" disabled={Boolean(active)} min={name==="top_p"?0.01:name==="max_tokens"?1:0} max={name==="temperature"?2:name==="top_p"?1:32768} step={name==="max_tokens"?1:0.01} value={Number.isFinite(props.generation[name])?props.generation[name]:""} onChange={event=>props.setGeneration({...props.generation,[name]:event.target.value===""?NaN:Number(event.target.value)})}/></label>)}
          <label className="field"><span>思考模式</span><select disabled={Boolean(active)} value={props.generation.thinking?.type??'default'} onChange={event=>{const {thinking,...base}=props.generation;props.setGeneration(event.target.value==='disabled'?{...base,thinking:{type:'disabled'}}:base)}}><option value="default">模型默认</option><option value="disabled">关闭（需受管连接支持）</option></select></label>
        </div><p role="status">{props.launcherStatus}</p></>:null}
        <details className="environment-details"><summary>工具依赖与未匹配原因</summary>
          <p>{requiredTools.length?requiredTools.join('、'):'本轮未声明工具依赖'}</p>
          {props.environmentMatches.filter(item=>item.issues.length).map(item=><p key={item.runtime.runtimeId}><strong>{item.runtime.name}</strong>：{item.issues.join('；')}</p>)}
          {!props.runtimeEnvironmentId&&props.runtime==='runtime_launcher'&&props.environmentMatches.filter(item=>item.runtime.runtimeType===props.runtimeFamily&&!item.issues.length).length>1?<p>存在多个兼容数据环境，请确认要使用的来源。</p>:null}
        </details>
        {['runtime_launcher','dual_runtime'].includes(props.runtime)?<p className="runtime-lifecycle"><Activity size={15}/>临时 Agent · 按本次评测构建 · 每题独立会话 · 结束后自动发起回收</p>:null}
        {props.runtime==="dual_runtime"?null:props.runtime === "replay" ? <div className="environment-readiness replay"><Archive size={16} /><span><strong>冻结证据已就绪</strong>本轮复核固化的真实或受控输出；左右版本与模型保持锁定。</span></div> : props.runtime === "direct_model" ? <div className="environment-readiness ready"><CircleCheck size={16} /><span><strong>文本执行环境</strong>适用于不依赖工具的上传 Skill，本轮不连接 MCP。</span></div> : <div className={`environment-readiness ${props.environmentChecking ? "checking" : props.environmentInspection?.status ?? "waiting"}`}>
          {props.environmentChecking ? <RefreshCw className="spin" size={16} /> : props.environmentInspection?.status === "ready" ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
          <span><strong>{props.environmentChecking ? "正在自动准备环境" : props.environmentInspection?.status === "ready" ? "在线环境已就绪" : props.environmentInspection?.error ?? "请选择执行环境"}</strong>{runtimeOption ? `${runtimeTypeLabel(runtimeOption.runtimeType)} · ${runtimeOption.mcpEnvironmentIds.length} 个 MCP · ${props.environmentInspection?.status === 'ready' ? `已发现 ${props.environmentInspection.toolCount} 个工具` : '工具待确认'} · 本轮需要 ${requiredTools.length} 项` : runtimeEnvironment ? `${runtimeTypeLabel(runtimeEnvironment.runtimeType)} · ${linkedMcp.length} 个 MCP 已绑定 · ${props.environmentInspection?.status === 'ready' ? `已发现 ${props.environmentInspection.toolCount} 个工具` : '工具待确认'} · 本轮需要 ${requiredTools.length} 项` : "评测开始前将自动检查 Runtime 与关联 MCP。"}</span>
        </div>}
      </section>

      <div className="comparison-grid">
        <ComparisonConfigurator side="A" title="对照组" runtimeName={props.runtime==='dual_runtime'?leftRuntimeOption?.name:runtimeOption?.name} selection={props.leftVariantSelection} modelKeyValue={props.leftModelKey} versions={props.versionOptions} models={comparisonModels} locked={replayLocked} onSelectionChange={props.setLeftVariantSelection} onModelChange={props.setLeftModelKey} />
        <div className="comparison-arrow"><ArrowRight size={20} /></div>
        <ComparisonConfigurator side="B" title="目标组" runtimeName={props.runtime==='dual_runtime'?rightRuntimeOption?.name:runtimeOption?.name} selection={props.rightVariantSelection} modelKeyValue={props.rightModelKey} versions={props.versionOptions} models={comparisonModels} locked={replayLocked} target onSelectionChange={props.setRightVariantSelection} onModelChange={props.setRightModelKey} />
      </div>

      {props.sameConfiguration ? <div className="comparison-warning warning">左右配置完全相同，无法形成有效对比。</div> : props.mixedVariables ? <div className="comparison-warning info">Skill 与模型同时变化，本轮只能说明综合方案差异，不能把提升单独归因于 Skill。</div> : null}
      {props.comparisonMode==='model'&&comparisonModels.length<2?<p className="comparison-warning warning">当前环境只有一个可用模型，暂无第二个模型可比较。</p>:null}
      {(props.runtime === 'runtime_launcher'||props.runtime==='dual_runtime') && !props.selectedVariantsHaveArtifacts ? <div className="comparison-warning warning">所选 Skill 版本只有评测定义，本机尚未上传对应实体包；请先到 Skill 资产上传该版本。</div> : null}

      <section className="cases-section">
        <div className="section-title"><div><h2>评测任务</h2></div>{!isPreparation && props.runtime !== "replay" && props.runtime!=="dual_runtime" ? <div className="question-mode" role="group" aria-label="题目来源">
          <button aria-pressed={dynamic} disabled={Boolean(active)} onClick={() => { props.setCaseSource("ai_generated"); props.setJudgeMode("model"); }}><Sparkles size={15} />AI 动态出题</button>
          <button aria-pressed={!dynamic} disabled={Boolean(active)} onClick={() => props.setCaseSource("fixed")}><Archive size={15} />固定回归题</button>
        </div> : <span>{props.selectedCases.length}/{props.cases.length} 题</span>}</div>
        {dynamic ? <div className="question-source"><Sparkles size={16} /><span>{props.job?.questionSet ? `本轮 ${questions.length} 题 · ${props.job.questionSet.model.modelId} · 题集 ${props.job.questionSet.fingerprint.slice(0, 12)}` : active ? props.job?.stageLabel : `待开始 · ${props.catalog.modelRoles.analyzer.model.modelId} · 最多 3 题`}</span></div> : null}
        {dynamic && !props.catalog.modelRoles.analyzer.configured ? <div className="run-error">出题模型未配置，请在服务端配置 Analyzer 或选择固定回归题。</div> : null}
        {props.holdoutCaseCount > 0 ? <label className="holdout-option">
          <input type="checkbox" checked={props.includeHoldout} disabled={Boolean(active)}
            onChange={event => props.setIncludeHoldout(event.target.checked)} />
          <span className="case-copy"><strong>包含冻结留出题（{props.holdoutCaseCount} 题）</strong>
            <small>本轮共 {props.selectedCases.length + (props.includeHoldout ? props.holdoutCaseCount : 0)} 题，两端使用相同题集。</small></span>
        </label> : null}
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
  runtimeName?:string;
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
  const selected = selectedVersion(props.selection,props.versions);
  return <section className={props.target ? "comparison-panel target configurable" : "comparison-panel configurable"}>
    <div className="comparison-panel-head"><div className="side-badge">{props.side}</div><div><span>{props.title}</span><strong>对比配置</strong></div>{props.locked ? <small><Archive size={12} />配置已锁定</small> : null}</div>
    <div className="comparison-fields">
      {props.runtimeName?<div className="field"><span>运行环境</span><strong>{props.runtimeName}</strong></div>:null}
      <label className="field"><span>Skill</span><select value={selected?versionSelectionKey(selected):props.selection} disabled={props.locked} onChange={event => props.onSelectionChange(event.target.value)}>
        <option value="without_target_skill">不加载当前 Skill</option>
        {props.versions.map(item => <option key={versionSelectionKey(item)} value={versionSelectionKey(item)}>v{item.version}{props.versions.filter(other=>other.version===item.version).length>1?` · ${item.artifactSha256?.slice(0,8)??'摘要未记录'}`:''}</option>)}
      </select></label>
      <label className="field"><span>模型</span><select value={props.modelKeyValue} disabled={props.locked} onChange={event => props.onModelChange(event.target.value)}>
        {props.models.map(model => {const label=model.label??model.modelId,upstream=model.upstreamModelId??model.modelId;return <option key={modelKey(model)} value={modelKey(model)} disabled={Boolean(model.availability && model.availability !== "ready")} title={model.statusNote}>{label===upstream?upstream:`${label} · ${upstream}`}{model.availability === "unavailable" ? " · 暂不可用" : model.availability === "unverified" ? " · 待验证" : ""}</option>})}
      </select></label>
    </div>
    <div className="comparison-foot">{selected ? <span>装配 Skill v{selected.version}{selected.artifactSha256 ? <> · SHA <b className="mono">{selected.artifactSha256.slice(0, 12)}</b></> : null}</span> : <span>{props.selection==='without_target_skill'?'不装配当前 Skill；保留相同的 Runtime 与工具环境。':'所选版本无法唯一确定，请重新选择。'}</span>}</div>
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
      <div className="progress-block"><strong>{progress}%</strong><div><span style={{ width: `${progress}%` }} /></div><small>{job.progress.completedRuns}/{job.progress.totalRuns || "-"} 项案例处理</small></div>
    </div>
    {job.configuration.runtime.type === "replay" ? <div className="evidence-notice"><Archive size={16} /><span><strong>冻结证据回放</strong>：本轮复核已固化输出和评分，不代表刚刚重新调用了 Agent。</span></div> : <div className="evidence-notice live"><Activity size={16} /><span><strong>在线评测</strong>：各题执行结果分别核对；评测结束不代表所有案例执行或质量验收通过。</span></div>}
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
    return <article key={side}><span>{side === "left" ? "A · 对照组" : "B · 目标组"}</span><small className="live-state">{evidence ? evidence.metadata?.executionDisposition === 'NOT_EXECUTED' ? '未执行' : evidence.status === "completed" ? "执行完成" : "执行失败" : live?.status ?? "等待执行"}</small>
      <div className="tool-events">{(evidence?.toolCalls ?? live?.toolCalls ?? []).map((tool,i) => <span key={`${tool.name}-${i}`} className={tool.status}>{tool.status === "running" ? <RefreshCw className="spin" size={12} /> : null}{tool.name} · {tool.status}</span>)}</div>
      <MarkdownContent streaming={!evidence && !TERMINAL.has(job.status)} content={evidence?.output || evidence?.error || live?.output || "等待模型输出"} />{evidence?<ExecutionIdentity evidence={evidence}/>:null}</article>;
  })}</div></div>)}</div>;
}

function ExecutionIdentity({evidence}:{evidence:Evidence}) {
  const data=evidence.metadata;
  if(!data?.runtime)return null;
  const labels=evidenceLabels(data,evidence.toolCalls.length);
  return <details className="question-receipt"><summary>{data.runtime.type} {data.runtime.version} · {Math.round(evidence.elapsedMs)} ms · {evidence.status==="completed"?"执行返回":"执行失败"}</summary>
    <p>Skill 版本：{evidence.skillVersion??"未记录"} · {data.publicationStatus==="NOT_PUBLISHED"?"临时候选，未发布":data.publicationStatus==="PUBLISHED"?"已发布方法":"发布状态未记录"}</p>
    <p>工具：{labels.tools}</p>
    {evidence.toolCalls.length?<p>{evidence.toolCalls.map(item=>`${item.name} (${item.status})`).join("、")}</p>:null}
    <p>Token：{typeof evidence.usage?.totalTokens==='number'?evidence.usage.totalTokens:'未知，未取得用量'}</p>
    <p>{labels.archive}</p><p>{labels.cleanup}</p>
    {evidence.error?<p role="alert">{evidence.error}</p>:null}
    <dl>{Object.entries({"实际方法摘要":data.loadedSkillDigest,"安装资产摘要":data.installationDigest,"制品 Lock":data.artifactLockSha256,"运行 Lock":data.runtimeLockSha256,
      "运行记录请求":data.executionHistoryRequestId,"保留证据引用":data.retainedEvidenceRef,"业务日期":data.businessDate,"时区":data.businessTimeZone}).map(([label,value])=><div key={label}><dt>{label}</dt><dd style={{overflowWrap:"anywhere",marginInlineStart:0}}>{value == null ? "未记录" : typeof value === "object" ? JSON.stringify(value) : value}</dd></div>)}</dl>
    <p>声明生成参数：{JSON.stringify(data.declaredModelParameters??{})}</p>
    <p>{data.modelParametersVerified?"参数已核验":"此处是声明或宿主记录，不单独证明模型端实际收到的参数"}</p>
  </details>;
}

function ReportResult({ job }: { job: EvaluationJob }) {
  const publicDemo = useContext(PublicDemoContext);
  const report = job.report!;
  const runtimeComparison = job.configuration.evaluationMode==='candidate_runtime_comparison' || report.cases.some(item=>item.judge?.runtimeComparison);
  return <div className="report-result">
    {report.cases.some(c => c.right.metadata?.dataMode?.includes("synthetic")) ? <div className="evidence-notice">数据来源：只读模拟业务快照；模型与 MCP 工具本轮实际执行，不代表真实客户业务验收。</div> : null}
    <div className={`score-strip${runtimeComparison ? ' runtime-goal-strip' : ''}`}>
      {runtimeComparison ? (['left','right'] as const).map(side=>{const counts=runtimeGoalCounts(report.cases,side);return <div key={side}><span>{side==='left'?'A':'B'} · 独立目标评估</span><strong>{counts.PASS}/{report.cases.length} 通过</strong><small>未通过 {counts.FAIL} · 无法判断 {counts.INDETERMINATE} · 未评估 {counts.unavailable}</small><small>平均执行 {(report.summary.meanElapsedMs[side]/1000).toFixed(1)}s</small></div>;}) : <><div><span>A 胜</span><strong>{report.summary.leftWins}</strong></div><div className="winner-metric"><span>B 胜</span><strong>{report.summary.rightWins}</strong></div><div><span>持平</span><strong>{report.summary.ties}</strong></div><div><span>平均耗时</span><strong>{Math.round((report.summary.meanElapsedMs.left + report.summary.meanElapsedMs.right) / 2000)}s</strong></div></>}
      <div className="report-downloads">{(['html','json'] as const).map(format=><button className="button secondary" key={format} onClick={()=>void downloadApi(`/api/runs/${job.jobId}/export?format=${format}`,`${job.jobId}.${format}`).catch(error=>window.alert(error.message))}><Download size={15}/>{format.toUpperCase()}</button>)}</div>
    </div>
    {runtimeComparison ? null : <ResultCharts report={report} />}
    {report.cases.map(item => <section className="result-case" key={item.caseId}>
      <header><div><span>{item.caseId}</span><h3>{item.name}</h3></div><strong className={`winner winner-${item.judge?.winner ?? "none"}`}>{runtimeComparison ? '逐侧验收' : item.judge?.winner === "right" ? "B 更优" : item.judge?.winner === "left" ? "A 更优" : item.judge ? "持平" : "未评阅"}</strong></header>
      <div className="answer-grid"><article><span>A · {item.left.skillVersion ? `v${item.left.skillVersion}` : '不装配当前 Skill'} · {item.left.modelId}</span><MarkdownContent content={item.left.output} /><ExecutionIdentity evidence={item.left}/></article><article><span>B · {item.right.skillVersion ? `v${item.right.skillVersion}` : '不装配当前 Skill'} · {item.right.modelId}</span><MarkdownContent content={item.right.output} /><ExecutionIdentity evidence={item.right}/></article></div>
      {runtimeComparison ? <RuntimeGoalResults item={item}/> : <div className="judge-summary"><Sparkles size={17} /><div><strong>金融专业评价</strong><MarkdownContent compact content={item.judge?.summary ?? item.judgeError ?? "未形成评价"} />{item.judge ? <div className="dimension-grid">{item.judge.dimensions.map(dimension => <div key={dimension.id}><span>{dimension.label}</span><b>{dimension.leftScore} / {dimension.rightScore}</b><small>{dimension.reason}</small></div>)}</div> : null}</div></div>}
    </section>)}
    <details className="question-receipt"><summary>运行结束与回收证据</summary>
      <p>这是运行结束后的 Launcher 观察，不是操作系统全资源审计。RELEASED 表示管理器已释放句柄；构建退休、案例工作区和临时候选须分别核对。</p>
      {report.finalization?<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(report.finalization,null,2)}</pre>:<p>旧记录没有最终回收观察，状态未知；不能从完成或取消推断。</p>}
    </details>
    {!publicDemo && job.configuration.runtime.type === "runtime_launcher" && job.status === "completed" ? <OptimizationPanel key={job.jobId} job={job} /> : null}
    <footer className="report-footer"><span>Runtime: {report.runtimeAdapterId}</span><span>Judge: {report.judgeId}</span><span className="mono">报告 {report.reportFingerprint.slice(0, 16)}</span><span>执行服务提交：{report.codeRevision?`${report.codeRevision.commit} (${report.codeRevision.workingTree})`:'旧记录未记录'}</span></footer>
  </div>;
}

function MigrationWorkspace({catalog,source,onChanged,onUseAsset}:{catalog:Catalog;source:SkillAsset|null;onChanged():Promise<void>;onUseAsset(asset:SkillAsset):Promise<void>}) {
  const [uploadedAsset,setUploadedAsset]=useState(source),[error,setError]=useState(''),[uploading,setUploading]=useState(false);
  const [imports,setImports]=useState<ImportResult[]>([]),[refreshKey,setRefreshKey]=useState(0);
  const input=useRef<HTMLInputElement>(null);
  async function upload(files:File[]){if(uploading)return;setUploading(true);setError('');setImports([]);let single:SkillAsset|null=null;try{
    const results=await importMigrationFiles(files,async(bytes)=>{
      const asset=await api<SkillAsset>('/api/migrations/upload',{method:'POST',body:new Blob([bytes as BlobPart]),headers:{'content-type':'application/zip'}});
      // Single uploads are opened and created by MigrationPanel. Batch uploads remain in
      // the project list, so create one project per successful file here.
      if(files.length>1)await api('/api/migrations',{method:'POST',body:JSON.stringify({sourceAssetId:asset.assetId,name:`${asset.displayName} 迁移`,createMode:'new'})});
      single=asset;
    });setImports(results);await onChanged();setUploadedAsset(files.length===1?single:null);setRefreshKey(n=>n+1);
  }catch(e){setError(String(e));}finally{setUploading(false);}}
  return <div className="workspace"><section className="workspace-header"><div><span className="eyebrow">SKILL MIGRATION</span><h1>Skill 迁移</h1></div></section>
    {error&&<p role="alert">{error}</p>}{uploading&&<p role="status">上传中</p>}
    {imports.length>0&&<ul aria-label="导入结果">{imports.map((r,i)=><li key={i}>{r.name}：{r.status==='IMPORTED'?'已导入':r.error}</li>)}</ul>}
    <input hidden ref={input} type="file" multiple accept=".zip,.md,application/zip,text/markdown" onChange={e=>{const files=Array.from(e.target.files??[]);if(files.length)void upload(files);e.target.value='';}}/>
    <MigrationPanel catalog={catalog} api={api} uploadedAsset={uploadedAsset} refreshKey={refreshKey} onUseAsset={onUseAsset} onUpload={()=>{if(!uploading)input.current?.click();}}/>
  </div>;
}

function SkillAssetsView({ catalog, focusedAsset, onChanged, onSelectPreparation,onMigrate }: { catalog: Catalog; focusedAsset?:string|null;onChanged(): Promise<void>; onSelectPreparation(id: string): void;onMigrate(asset:SkillAsset):void }) {
  const [uploading, setUploading] = useState(false);
  const [preparing, setPreparing] = useState("");
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const suiteInput = useRef<HTMLInputElement | null>(null);
  const [suiteAsset,setSuiteAsset] = useState('');
  const [suiteId,setSuiteId] = useState('');
  const [importingSuite,setImportingSuite] = useState(false);
  const selectedAsset = catalog.uploadedSkills.find(a=>a.assetId===suiteAsset)
    ?? catalog.uploadedSkills.find(a=>a.assetId===focusedAsset) ?? catalog.uploadedSkills[0];
  const historicalSuites = catalog.preparations.filter(p=>p.skillAssetId===selectedAsset?.assetId);
  const selectedSuite = historicalSuites.find(p=>p.preparationId===suiteId) ?? historicalSuites[0];
  async function importSuite(file:File){
    if(!selectedAsset||importingSuite)return;
    setImportingSuite(true);setMessage('');
    try{
      if(file.size>1048576)throw new Error('测试集 JSON 不得超过 1 MB');
      const imported=await api<Preparation>(`/api/skills/${selectedAsset.assetId}/prepare/import`,{method:'POST',body:JSON.stringify(JSON.parse(await file.text()))});
      await onChanged();setSuiteId(imported.preparationId);setMessage('已创建测试集副本，原测试集与评分未修改。');
    }catch(error){setMessage(error instanceof Error?error.message:String(error));}
    finally{setImportingSuite(false);}
  }
  useEffect(()=>{if(focusedAsset)document.getElementById(`asset-${focusedAsset}`)?.focus();},[focusedAsset,catalog.uploadedSkills]);
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
    {selectedAsset&&<section className="asset-section asset-suite-picker" aria-label="历史测试集与导入副本">
      <h2>测试集</h2>
      <label>源资产<select value={selectedAsset.assetId} onChange={e=>{setSuiteAsset(e.target.value);setSuiteId('');}}>{catalog.uploadedSkills.map(a=><option key={a.assetId} value={a.assetId}>{a.displayName} · {a.version} · {a.artifactSha256.slice(0,8)}</option>)}</select></label>
      <label>历史测试集<select value={selectedSuite?.preparationId??''} onChange={e=>setSuiteId(e.target.value)} disabled={!historicalSuites.length}>{!historicalSuites.length&&<option value="">暂无测试集</option>}{historicalSuites.map(p=><option key={p.preparationId} value={p.preparationId}>{p.summary} · {p.cases.length}题 · {p.createdAt} · {p.preparationId}</option>)}</select></label>
      <div className="asset-actions"><button className="button secondary" disabled={!selectedSuite||importingSuite} onClick={()=>selectedSuite&&onSelectPreparation(selectedSuite.preparationId)}><ChevronRight size={16}/>使用所选测试集</button>
      <button className="button secondary" disabled={importingSuite} onClick={()=>suiteInput.current?.click()}><FileArchive size={16}/>{importingSuite?'导入中':'导入测试集副本'}</button></div>
      <input hidden ref={suiteInput} type="file" accept=".json,application/json" onChange={e=>{const file=e.target.files?.[0];if(file)void importSuite(file);e.target.value='';}}/>
    </section>}
    <section className="asset-section"><div className="section-title"><div><h2>用户上传</h2><p>上传资产只用于当前评测服务，不会发布到 Skill 市场。</p></div><span>{catalog.uploadedSkills.length} 个</span></div>
      <div className="asset-table">{catalog.uploadedSkills.length ? catalog.uploadedSkills.map(skill => {
        const preps = catalog.preparations.filter(item => item.skillAssetId === skill.assetId);
        return <div className="asset-row" id={`asset-${skill.assetId}`} tabIndex={-1} key={skill.assetId}><div className="asset-icon"><FileArchive size={20} /></div><div><strong>{skill.displayName}</strong>{focusedAsset===skill.assetId&&<span className="state-tag">本次迁移候选 · 待执行验证</span>}<small>{skill.skillId}@{skill.version} · {skill.fileCount} 个文件</small><p>{skill.description}</p><em className="mono">SHA {skill.artifactSha256.slice(0, 16)}</em></div><div className="asset-actions"><button className="button secondary" onClick={()=>onMigrate(skill)}><ArrowRightLeft size={16}/>发起迁移</button><button className="button secondary" onClick={() => prepare(skill.assetId)} disabled={preparing === skill.assetId || !catalog.modelRoles.analyzer.configured}><Sparkles size={16} />{preparing === skill.assetId ? "出题中" : "AI 生成试题"}</button>{preps[0] ? <button className="icon-button" title="进入评测" onClick={() => onSelectPreparation(preps[0].preparationId)}><ChevronRight size={18} /></button> : null}</div></div>;
      }) : <div className="empty-table">尚未上传 Skill ZIP</div>}</div>
    </section>
    <section className="asset-section"><div className="section-title"><div><h2>预制 Eval Pack</h2><p>由金融 SOP、Golden Cases 与 Judge Rubric 共同定义。</p></div><span>{catalog.evalPacks.length} 套</span></div><div className="asset-table">{catalog.evalPacks.map(pack => <div className="asset-row" key={pack.packId}><div className="asset-icon"><Archive size={20} /></div><div><strong>{pack.targetSkillId}</strong><small>v{pack.targetSkillVersion} · {pack.caseCount} 题 · {pack.domain}</small><p>{pack.description}</p><em className="mono">PACK {pack.fingerprint.slice(0, 16)}</em></div><span className={pack.replayReady ? "state-tag ready" : "state-tag"}>{pack.replayReady ? "可回放" : "需在线 Runtime"}</span></div>)}</div></section>
  </div>;
}


function HistoryView({ jobs, selected, onSelect, onRetry }: { jobs: EvaluationJob[]; selected: EvaluationJob | null; onSelect(job: EvaluationJob): void; onRetry(job: EvaluationJob): void }) {
  const current = selected ?? jobs[0] ?? null;
  return <div className="workspace"><section className="workspace-header"><div><span className="eyebrow">RUN HISTORY</span><h1>真实运行记录</h1><p>保留运行配置、左右证据、失败原因和可导出报告。</p></div></section><div className="history-layout"><div className="history-list">{jobs.map(job => <button key={job.jobId} className={current?.jobId === job.jobId ? "history-item active" : "history-item"} onClick={() => onSelect(job)}><div><strong>{job.pack?.targetSkillId ?? "准备中"}</strong><span className={`run-status ${job.status}`}>{statusText(job.status)}</span></div><small>{formatTime(job.updatedAt)} · {job.pack?.caseCount ?? 0} 题</small><p>{job.report?.summary.headline ?? job.error?.message ?? job.stageLabel}</p></button>)}</div><div>{current ? <><RunEvidence job={current} />{["failed", "cancelled", "interrupted"].includes(current.status) ? <button className="button secondary history-retry" onClick={() => onRetry(current)}><RotateCcw size={16} />重试这一轮</button> : null}</> : <EmptyRun />}</div></div></div>;
}
