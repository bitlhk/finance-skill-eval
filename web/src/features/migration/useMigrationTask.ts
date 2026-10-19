import { useCallback, useEffect, useState } from 'react';
import type { BundleTask } from '../../../../src/migration/tasks/domain/task-model';
export type MigrationApi = <T>(url: string, init?: RequestInit) => Promise<T>;
export function useMigrationTask(api: MigrationApi) {
  const [tasks, setTasks] = useState<BundleTask[]>([]);
  const [pollError, setPollError] = useState('');
  const [task, setTask] = useState<BundleTask | null>(null);
  const list = useCallback(async () => { setTasks(await api<BundleTask[]>('/api/migration-tasks')); }, [api]);
  const active = task?.attempts.find(a => a.status === 'RUNNING');
  useEffect(() => {
    setPollError('');
    if (!task || !active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<BundleTask>('/api/migration-tasks/' + task.id);
        if (!disposed) { setTask(current => current?.id === next.id ? next : current); setPollError(''); }
      } catch { if (!disposed) setPollError('任务状态暂时无法刷新，正在重试；请勿重复提交。'); }
      finally { if (!disposed) timer = setTimeout(() => void poll(), 1500); }
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [api, task?.id, active?.id]);
  return { tasks, task, setTask, list, pollError };
}
