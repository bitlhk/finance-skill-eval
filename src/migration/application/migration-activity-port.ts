import type { Activity } from '../domain/migration-activity.js';

export interface MigrationActivityPort {
  get(id: string): Promise<Activity | null>;
  emit(kind: string, label: string, text?: string): void;
  cancel(id: string): void;
  run<T>(id: string, work: () => Promise<T>, options?: {
    signal?: AbortSignal;
    taskId?: string;
    terminalStatus?: () => Promise<Activity['status']>;
  }): Promise<T>;
}
