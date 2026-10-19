import { sampleSuite } from './presentation';
import { useMigrationTask } from './useMigrationTask';
import { useEffect, useRef, useState } from 'react';
import type { Catalog } from '../../types';
import type { BundleTask, BundleConfiguration } from '../../../../src/migration/tasks/domain/task-model';
import { importMigrationFiles } from '../../migration-import';

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
    [preview, setPreview] = useState<{ path: string; before: string; after: string; } | null>(null),
    [runId, setRunId] = useState('');
  const zipInput = useRef<HTMLInputElement>(null),
    filesInput = useRef<HTMLInputElement>(null);
  const current = task?.candidates.find((c) => c.id === task.currentCandidateId),
    active = task?.attempts.find((a) => a.status === 'RUNNING');
  const latestAttempt = task?.attempts[task.attempts.length - 1],
    run = task?.runs.find((r) => r.id === runId) ?? task?.runs[task.runs.length - 1];
  const runtime = catalog.executionRuntimes.find((r) => r.runtimeId === config.environmentId);
  useEffect(() => { void list().catch(e => setError(String(e))); }, [list]);
  useEffect(() => { if (initialTask) select(initialTask); }, [initialTask?.id]);
  useEffect(() => { if (source) { setSelected([source.assetId]); setName(source.displayName + ' 迁移'); } }, [source?.assetId]);
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
    if (!name.trim() || !goal.trim() || !target.trim())
      throw new Error('请先填写任务名称、业务目标和目标环境');
    const query = new URLSearchParams({ name, goal, target });
    select(
      await api<BundleTask>('/api/migration-tasks/upload?' + query, {
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
      const asset = await api<{ assetId: string; }>('/api/migrations/upload', {
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
  const disabled = busy || Boolean(active);
  return { refreshCatalog: onChanged, pollError, catalog, api, tasks, task, setTask, stage, setStage, name, setName, goal, setGoal, target, setTarget, selected, setSelected, busy, error, message, setMessage, config, setConfig, suite, setSuite, preview, runId, setRunId, zipInput, filesInput, current, active, latestAttempt, run, runtime, list, select, act, post, start, uploadZip, uploadMembers, showFile, disabled };
}
export type MigrationWorkbench = ReturnType<typeof useMigrationWorkbench>;
