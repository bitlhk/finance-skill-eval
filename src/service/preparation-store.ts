import { randomUUID } from "node:crypto";
import path from "node:path";
import type { EvalCase, EvalPack, EvaluationContextSnapshot, ModelRef } from "../contracts.js";
import { fingerprint } from "../contracts.js";
import type { SkillAssetRecord } from "./skill-store.js";
import { ensureDirectory, listJsonFiles, readJson, writeJsonAtomic } from "./file-store.js";

export type PreparedEvaluation = {
  schemaVersion: "finance.skill-eval.preparation.v1";
  preparationId: string;
  skillAssetId: string;
  skillId: string;
  skillVersion: string;
  summary: string;
  cases: EvalCase[];
  source: "ai_generated" | "manual";
  evaluationContext: EvaluationContextSnapshot | null;
  createdAt: string;
};

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
    source: PreparedEvaluation["source"];
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
      source: input.source,
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
    const packFile = {
      schemaVersion: "finance.skill-eval.pack.v1" as const,
      packId: `uploaded-${input.preparation.preparationId}`,
      version: "1.0.0",
      domain: "uploaded-skill",
      targetSkillId: input.preparation.skillId,
      targetSkillVersion: input.preparation.skillVersion,
      description: input.preparation.summary,
      models: {
        analyzer: input.analyzerModel,
        execution: { left: input.executionModel, right: input.executionModel },
        judge: input.judgeModel,
      },
      variants: {
        left: {
          mode: "without_target_skill" as const,
          skillId: input.preparation.skillId,
        },
        right: {
          mode: "skill_version" as const,
          skillId: input.preparation.skillId,
          version: input.preparation.skillVersion,
        },
      },
      judgeProfileFile: "generated",
      caseFiles: [],
      metadata: {
        source: input.preparation.source,
        preparationId: input.preparation.preparationId,
      },
    };
    const judgeProfile = {
      schemaVersion: "finance.skill-eval.judge-profile.v1" as const,
      profileId: "generic-finance-skill-value-judge",
      version: "1.0.0",
      reviewerLabel: "金融 Skill 专业价值 Judge",
      domainInstructions: [
        "判断 Skill 是否实质提升专业判断，而不是只增加篇幅或规则复述。",
        "重点比较业务问题识别、结果完整性、表达清晰度和下一步可执行性。",
        "没有来源的事实、数字或工具执行结果不得获得奖励。",
      ].join("\n"),
      dimensions: [
        { id: "professional_fit" as const, label: "专业匹配度", description: "是否体现岗位专业判断" },
        { id: "business_completeness" as const, label: "业务完整性", description: "是否覆盖任务所需闭环" },
        { id: "clarity" as const, label: "结构与清晰度", description: "是否易于理解和使用" },
        { id: "actionability" as const, label: "可执行性", description: "是否形成明确下一步" },
      ],
    };
    return {
      ...packFile,
      sourceFile: path.join(this.directory, `${input.preparation.preparationId}.json`),
      cases: input.preparation.cases,
      judgeProfile,
      packFingerprint: fingerprint({ pack: packFile, cases: input.preparation.cases, judgeProfile }),
    };
  }
}
