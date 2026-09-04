import path from "node:path";
import type { EvaluationProgress } from "../runner.js";
import type { EvaluationReport } from "../report.js";
import type { RunConfiguration } from "./contracts.js";
import { ensureDirectory, listJsonFiles, readJson, writeJsonAtomic } from "./file-store.js";

export type EvaluationJobStatus =
  | "queued"
  | "preparing"
  | "running"
  | "judging"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type EvaluationJob = {
  schemaVersion: "finance.skill-eval.job.v1";
  jobId: string;
  status: EvaluationJobStatus;
  stageLabel: string;
  configuration: RunConfiguration;
  pack: {
    packId: string;
    version: string;
    targetSkillId: string;
    targetSkillVersion: string;
    caseCount: number;
  } | null;
  progress: Pick<EvaluationProgress, "completedRuns" | "totalRuns" | "caseId" | "side">;
  evidence: EvaluationProgress["evidence"][];
  report: EvaluationReport | null;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export class EvaluationJobStore {
  private readonly directory: string;
  private readonly cache = new Map<string, EvaluationJob>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(dataDirectory: string) {
    this.directory = path.join(dataDirectory, "runs");
  }

  async initialize(): Promise<void> {
    await ensureDirectory(this.directory);
    for (const file of await listJsonFiles(this.directory)) {
      const job = await readJson<EvaluationJob>(file);
      if (["queued", "preparing", "running", "judging"].includes(job.status)) {
        job.status = "interrupted";
        job.stageLabel = "服务重启，运行已中断";
        job.error = {
          code: "SERVICE_RESTARTED",
          message: "评测服务重启，本次运行未继续执行，可发起单次重试。",
          retryable: true,
        };
        job.completedAt = new Date().toISOString();
        job.updatedAt = job.completedAt;
        await writeJsonAtomic(file, job);
      }
      this.cache.set(job.jobId, job);
    }
  }

  list(limit = 50): EvaluationJob[] {
    return [...this.cache.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 200));
  }

  get(jobId: string): EvaluationJob | null {
    return this.cache.get(jobId) ?? null;
  }

  async save(job: EvaluationJob): Promise<EvaluationJob> {
    job.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(job);
    const previous = this.writes.get(job.jobId) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() => writeJsonAtomic(path.join(this.directory, `${job.jobId}.json`), snapshot));
    this.writes.set(job.jobId, write);
    try {
      await write;
      this.cache.set(job.jobId, snapshot);
    } finally {
      if (this.writes.get(job.jobId) === write) this.writes.delete(job.jobId);
    }
    return snapshot;
  }
}
