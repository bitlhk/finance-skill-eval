import { randomUUID } from "node:crypto";
import path from "node:path";
import type { EvalCase, EvalPack, EvaluationContextSnapshot, ModelRef } from "../contracts.js";
import type { SkillAssetRecord } from "./skill-store.js";
import type { PreparedEvaluation } from '../shared/contracts/prepared-evaluation.js';
import { buildPreparedEvaluationPack } from '../shared/prepared-evaluation-pack.js';
export type { PreparedEvaluation } from '../shared/contracts/prepared-evaluation.js';
import { ensureDirectory, listJsonFiles, readJson, writeJsonAtomic } from "./file-store.js";

export class PreparationStore {
  private readonly directory: string;

  constructor(dataDirectory: string) {
    this.directory = path.join(dataDirectory, "preparations");
  }

  async initialize(): Promise<void> {
    await ensureDirectory(this.directory);
  }

  async list(): Promise<PreparedEvaluation[]> {
    const records = await Promise.all(
      (await listJsonFiles(this.directory)).map(file => readJson<PreparedEvaluation>(file)),
    );
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async get(preparationId: string): Promise<PreparedEvaluation | null> {
    if (!/^[a-z0-9-]+$/u.test(preparationId)) return null;
    try {
      return await readJson<PreparedEvaluation>(path.join(this.directory, `${preparationId}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async create(input: {
    skill: SkillAssetRecord;
    summary: string;
    cases: EvalCase[];
    holdoutCases?: EvalCase[];
    source: PreparedEvaluation["source"];
    assessmentMode?:'natural_language';
    comparisonOnly?:boolean;
    evaluationContext?: EvaluationContextSnapshot | null;
  }): Promise<PreparedEvaluation> {
    const record: PreparedEvaluation = {
      schemaVersion: "finance.skill-eval.preparation.v1",
      preparationId: `prep-${randomUUID().slice(0, 12)}`,
      skillAssetId: input.skill.assetId,
      skillId: input.skill.skillId,
      skillVersion: input.skill.version,
      summary: input.summary,
      cases: input.cases,
      holdoutCases: input.holdoutCases ?? [],
      source: input.source,
      ...(input.assessmentMode?{assessmentMode:input.assessmentMode}:{}),
      ...(input.comparisonOnly?{comparisonOnly:true}:{}),
      evaluationContext: input.evaluationContext ?? null,
      createdAt: new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(this.directory, `${record.preparationId}.json`), record);
    return record;
  }

  buildPack(input: {
    preparation: PreparedEvaluation;
    analyzerModel: ModelRef;
    executionModel: ModelRef;
    judgeModel: ModelRef;
  }): EvalPack {
    return buildPreparedEvaluationPack({...input,sourceFile:path.join(this.directory,`${input.preparation.preparationId}.json`)});
  }
}
