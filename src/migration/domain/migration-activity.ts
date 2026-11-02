export type ActivityEvent = { id: number; at: string; kind: string; label: string; text?: string };
export type Activity = {
  taskId: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
  startedAt: string;
  updatedAt: string;
  events: ActivityEvent[];
};
