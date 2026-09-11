import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadEvalPack } from "../eval-pack.js";
import type { EvalPack, ModelRef, SkillVariant } from "../contracts.js";

const featuredSkillCatalogSchema = z.strictObject({
  schemaVersion: z.literal("finance.skill-catalog.v1"),
  skills: z.array(z.strictObject({
    skillId: z.string().min(1),
    displayName: z.string().min(1),
    roleName: z.string().min(1),
    category: z.string().min(1),
    iconKey: z.enum(["wealth", "insurance", "research", "risk", "audit", "coach"]),
    author: z.string().min(1).optional(),
    featuredOrder: z.number().int().nonnegative(),
    summary: z.string().min(1),
    capabilities: z.array(z.string().min(1)).min(1).max(8),
  })).min(1),
});

type FeaturedSkillDefinition = z.infer<typeof featuredSkillCatalogSchema>["skills"][number];

function packPriority(pack: EvalPack): number {
  if(pack.cases.every(c=>c.replay)) return 2;
  return pack.metadata?.dataMode === 'synthetic-snapshot' ? 0 : 1;
}

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
  deterministicReady: boolean;
  fingerprint: string;
  models: {
    execution: { left: ModelRef; right: ModelRef };
  };
  variants: { left: SkillVariant; right: SkillVariant };
};

export type FeaturedSkillSummary = FeaturedSkillDefinition & {
  versions: Array<{
    version: string;
    packId: string;
    packVersion: string;
    replayReady: boolean;
    artifactSha256: string | null;
  }>;
  taskCount: number;
  requiredTools: string[];
  evaluationStatus: "ready" | "environment_required" | "pack_required";
};

export class EvalPackCatalog {
  private readonly packs = new Map<string, EvalPack>();
  private featuredSkills: FeaturedSkillDefinition[] = [];

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
    const featured = featuredSkillCatalogSchema.parse(
      parseYaml(await readFile(path.join(financeDirectory, "catalog.yaml"), "utf8")),
    );
    this.featuredSkills = featured.skills;
  }

  list(): EvalPackSummary[] {
    return [...this.packs.values()].sort((a,b) => packPriority(a)-packPriority(b)).map(pack => ({
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
      deterministicReady: pack.cases.every(c=>c.rubric.every(r=>r.allOf.length+r.anyOf.length+r.noneOf.length>0)),
      fingerprint: pack.packFingerprint,
      models: { execution: pack.models.execution },
      variants: pack.variants,
    }));
  }

  listFeaturedSkills(onlineRuntimeReady: boolean): FeaturedSkillSummary[] {
    return this.featuredSkills
      .map(definition => {
        const packs = [...this.packs.values()].filter(pack => pack.targetSkillId === definition.skillId)
          .sort((a,b) => packPriority(a)-packPriority(b));
        const versions = packs.map(pack => ({
          version: pack.targetSkillVersion,
          packId: pack.packId,
          packVersion: pack.version,
          replayReady: pack.cases.every(evalCase => Boolean(evalCase.replay)),
          artifactSha256: pack.variants.right.mode === "skill_version"
            ? pack.variants.right.artifactSha256 ?? null
            : null,
        }));
        const defaultCases = packs[0]?.cases ?? [];
        const requiredTools = [...new Set(defaultCases.flatMap(c=>c.requiredTools))].sort();
        return {
          ...definition,
          versions,
          taskCount: defaultCases.length,
          requiredTools,
          evaluationStatus: packs.length === 0
            ? "pack_required" as const
            : versions.some(version => version.replayReady) || onlineRuntimeReady
              ? "ready" as const
              : "environment_required" as const,
        };
      })
      .sort((left, right) => left.featuredOrder - right.featuredOrder);
  }

  get(packId: string): EvalPack | null {
    return this.packs.get(packId) ?? null;
  }
}
