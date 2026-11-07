import { sampleSuite } from './presentation';
import { migrationProgress } from './progress';
import { useMigrationTask } from './useMigrationTask';
import { useEffect, useRef, useState } from 'react';
import type { Catalog } from '../../types';
import type { BundleTask, BundleConfiguration } from "../../../../contracts/platform/responses";
import {startImportedTask} from './start-imported-task';
import {pendingBudgetContinuation} from './active-operation';

type Api = <T>(url: string, init?: RequestInit) => Promise<T>;
export function useMigrationWorkbench({
  catalog,
  api,
  onChanged,
  source,
  initialTask,
}: {
  catalog: Catalog;
  api: Api;
  onChanged(): Promise<void>;
  source?: { assetId: string; displayName: string; } | null;
  initialTask?: BundleTask | null;
}) {
  const { tasks, task, setTask, list, pollError } = useMigrationTask(api);
  const [stage, setStage] = useState(0);
  const [listView, setListView] = useState(!source && !initialTask);
  const [checkingRuntime, setCheckingRuntime] = useState(false);
  const [uploadingFile, setUploadingFile] = useState<string | null>(null);
  const [inputKind, setInputKind] = useState<'skill_package'|'agent_project'>('skill_package');
  const [projectNotes, setProjectNotes] = useState('');
  const [uploadFileName, setUploadFileName] = useState('');
  const [name, setName] = useState(''),
    [goal, setGoal] = useState(''),
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
    [preview, setPreview] = useState<{ path: string; before: string; after: string; } | null>(null),
    [runId, setRunId] = useState('');
  const zipInput = useRef<HTMLInputElement>(null);
  const current = task?.candidates.find((c) => c.id === task.currentCandidateId),
    active = task?.attempts.find((a) => a.status === 'RUNNING');
  const latestAttempt = task?.attempts[task.attempts.length - 1],
    run = task?.runs.find((r) => r.id === runId) ?? task?.runs[task.runs.length - 1];
  const runtime = catalog.executionRuntimes.find((r) => r.runtimeId === config.environmentId);
  const syncedAutomaticDelivery=useRef('');
  const automaticDelivery=task?.runtimeBuildRequests?.find(item=>item.requirements.requestId===task.selectedRuntimeBuildRequestId)?.automatic?.status==='SUCCEEDED'
    ?task.runtimeDelivery?.id:undefined;
  useEffect(()=>{
    if(!task?.configuration||!automaticDelivery)return;
    const key=task.id+':'+automaticDelivery;
    if(syncedAutomaticDelivery.current===key)return;
    syncedAutomaticDelivery.current=key;
    setConfig(task.configuration);
    void onChanged().catch(()=>setError('运行环境已绑定，但环境列表刷新失败，请稍后重试。'));
  },[task?.id,automaticDelivery,onChanged]);
  useEffect(() => { void list().catch(e => setError(String(e))); }, [list]);
  useEffect(() => { if (initialTask) select(initialTask); }, [initialTask?.id]);
  useEffect(() => { if (source) { setSelected([source.assetId]); setName(source.displayName + ' 迁移'); setListView(false); } }, [source?.assetId]);
  function select(next: BundleTask) {
    setListView(false);
    setTask(next);
    setConfig(
      (next.configurationConfirmed || next.startupCheckCurrent || next.verifiedRunId || next.builderStatus === 'BOUND' ? next.configuration : undefined) ?? {
        environmentId: '',
        modelId: '',
        timeoutMs: 310000,
        harnessTools: catalog.managedWorkspace ? [] : ['read_file', 'glob', 'list_files'],
      },
    );
    setSuite(JSON.stringify(next.suite ?? sampleSuite, null, 2));
    const nextStage = migrationProgress(next).findIndex((item, index) => index > 0 && item.available && item.status !== 'completed');
    setStage(next.inputKind === 'agent_project' && !next.analysis && !next.currentCandidateId ? 0 : next.verifiedRunId ? 6 : Math.max(1, nextStage));
    setProjectNotes('');
    setRunId('');
    setPreview(null);
    setError('');
    setMessage('');
  }
  function newTask() {
    setTask(null); setStage(0); setListView(false);
    setUploadFileName('');
    setInputKind('skill_package'); setProjectNotes('');
    setName(''); setGoal(''); setSelected([]);
    setError(''); setMessage(''); setPreview(null); setRunId('');
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
    api<BundleTask>('/api/migration-tasks/' + task!.id + suffix, {
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
    setUploadFileName(file.name);
    if (!/\.zip$/i.test(file.name)) throw new Error('请选择 ZIP 格式的工程包。');
    if (!file.size) throw new Error('工程包为空，请重新打包后上传。');
    if (file.size > 8 * 1024 * 1024) throw new Error('工程 ZIP 不能超过 8 MB，请精简后重新上传。');
    setUploadingFile(file.name);
    try {
      const options = creationOptions();
      const query = new URLSearchParams({ name: options.name, goal: options.goal, target: options.target, inputKind, projectNotes });
      const uploaded = await api<BundleTask>('/api/migration-tasks/upload?' + query, {
          method: 'POST',
          body: file,
          headers: { 'content-type': 'application/zip' },
        });
      await beginImportedTask(uploaded);
      await list().catch(() => setMessage(`已导入 ${file.name}。任务列表暂时未刷新，无需重复上传。`));
    } finally {
      setUploadingFile(null);
    }
  }
  async function beginImportedTask(imported:BundleTask) {
    select(imported);
    setMessage('已导入任务，正在启动 Agent。');
    try {
      const started=await startImportedTask(api,imported,crypto.randomUUID());
      if(started)setTask(started);
      setMessage('已导入任务，Agent 正在阅读材料并建立计划。');
    }catch(error){
      setMessage('任务已导入。');
      setError('Agent 启动状态未确认，请先查看任务进展或在对话中继续，无需重新上传：'+String(error));
    }
  }
  function creationOptions() {
    return { name: name.trim(), goal: goal.trim(), target: '' };
  }

  async function showFile(path: string) {
    const url = '/api/migration-tasks/' + task!.id + '/file?path=' + encodeURIComponent(path);
    const beforeId = current?.parentId;
    const before = await api<{ content: string; }>(
      url + (beforeId ? '&candidateId=' + encodeURIComponent(beforeId) : ''),
    ).catch(() => ({ content: '（该版本没有此文件，或内容为二进制）' }));
    const after = await api<{ content: string; }>(
      url + '&candidateId=' + encodeURIComponent(current!.id),
    ).catch(() => ({ content: '（文件已移除，或内容为二进制）' }));
    setPreview({ path, before: before.content, after: after.content });
  }
  const disabled = busy || Boolean(active) || Boolean(pendingBudgetContinuation(task)) || task?.rescoringOperation?.status === 'RUNNING'||Boolean(task?.runtimeBuildRequests?.some(item=>item.automatic&&['QUEUED','RUNNING'].includes(item.automatic.status)));
  return { inputKind, setInputKind, projectNotes, setProjectNotes, uploadingFile, uploadFileName, newTask, listView, setListView, checkingRuntime, setCheckingRuntime, creationOptions, beginImportedTask, refreshCatalog: onChanged, pollError, catalog, api, tasks, task, setTask, stage, setStage, name, setName, goal, setGoal, selected, setSelected, busy, error, message, setMessage, config, setConfig, suite, setSuite, preview, runId, setRunId, zipInput, current, active, latestAttempt, run, runtime, list, select, act, post, start, uploadZip, showFile, disabled };
}
export type MigrationWorkbench = ReturnType<typeof useMigrationWorkbench>;
