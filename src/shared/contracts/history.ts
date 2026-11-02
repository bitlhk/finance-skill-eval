export type HistoryOrigin = 'bundles' | 'migrations' | 'tasks' | 'environments';
export type HistoryKind = 'tasks' | 'environments';
export type HistorySummary = {
  origin: HistoryOrigin;
  id: string;
  name: string;
  createdAt: string | null;
  schemaVersion: string;
  readOnly: true;
  reason: string;
  nextStep: string;
  issue?: string;
};
export type HistoryDetail = HistorySummary & {
  record: Record<string, unknown> | null;
  snapshots: Array<{ revision: string; label: string }>;
  snapshotIssue?: string;
};
export type HistorySnapshot = {
  revision: string;
  digest: string | null;
  files: string[];
};
