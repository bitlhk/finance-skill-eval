import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadEvalPack } from "../eval-pack.js";
import type { EvalPack } from "../contracts.js";

export type EvalPackSummary = {
  packId: string;
  version: string;
  domain: string;
  targetSkillId: string;
  targetSkillVersion: string;
  description: string;
  caseCount: number;
  cases: Array<{
    caseId: string;
    name: string;
    prompt: string;
    evaluationGoal: string;
    requiredTools: string[];
  }>;
  replayReady: boolean;
  fingerprint: string;
};

export class EvalPackCatalog {
  private readonly packs = new Map<string, EvalPack>();

  constructor(private readonly rootDirectory: string) {}

  async initialize(): Promise<void> {
    const financeDirectory = path.join(this.rootDirectory, "packs", "finance");
    const entries = await readdir(financeDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pack = await loadEvalPack(path.join(financeDirectory, entry.name, "eval.yaml"));
      if (this.packs.has(pack.packId)) throw new Error(`Duplicate Eval Pack: ${pack.packId}`);
      this.packs.set(pack.packId, pack);
    }
  }

  list(): EvalPackSummary[] {
    return [...this.packs.values()].map(pack => ({
      packId: pack.packId,
      version: pack.version,
      domain: pack.domain,
      targetSkillId: pack.targetSkillId,
      targetSkillVersion: pack.targetSkillVersion,
      description: pack.description,
      caseCount: pack.cases.length,
      cases: pack.cases.map(evalCase => ({
        caseId: evalCase.caseId,
        name: evalCase.name,
        prompt: evalCase.prompt,
        evaluationGoal: evalCase.evaluationGoal,
        requiredTools: evalCase.requiredTools,
      })),
      replayReady: pack.cases.every(evalCase => Boolean(evalCase.replay)),
      fingerprint: pack.packFingerprint,
    }));
  }

  get(packId: string): EvalPack | null {
    return this.packs.get(packId) ?? null;
  }
}
