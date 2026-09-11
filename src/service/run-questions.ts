import { analyzeSkillAndGenerateCases } from "../analyzer.js";
import type { ModelAdapter } from "../adapters.js";
import { fingerprint, type EvalPack, type ModelRef } from "../contracts.js";
import type { FrozenQuestionSet } from "./job-store.js";

export async function generateRunQuestions(input: {
  pack: EvalPack;
  skill: { instructions: string; files: Record<string, string>; artifactSha256: string };
  model: ModelRef;
  adapter: ModelAdapter;
  count: number;
  generationId: string;
  signal: AbortSignal;
}): Promise<FrozenQuestionSet> {
  const scenario = input.pack.metadata.generationContext ? JSON.parse(input.pack.metadata.generationContext) as { querySubjectRefs?: string[] } : null;
  // Only professional references, never hidden answers or holdout fixtures.
  let remaining = 28_000;
  const references: Record<string, string> = {};
  for (const [name, content] of Object.entries(input.skill.files).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^(references|templates)\/.*\.md$/u.test(name) || /evals?\/|holdout|sealed|labels/iu.test(name) || remaining <= 0) continue;
    references[name] = content.slice(0, Math.min(remaining, 10_000));
    remaining -= references[name].length;
  }
  const result = await analyzeSkillAndGenerateCases({
    modelAdapter: input.adapter,
    model: input.model,
    skillId: input.pack.targetSkillId,
    skillSource: JSON.stringify({ instructions: input.skill.instructions.slice(0, 32_000), references }),
    domainContext: JSON.stringify({ domain: input.pack.domain, dataMode: input.pack.metadata.dataMode, availableScenarioContext: input.pack.metadata.generationContext }),
    maximumCases: input.count,
    generationId: input.generationId,
    existingPrompts: input.pack.cases.map(item => item.prompt),
    signal: input.signal,
    caseDesignContext: {
      allowedTools: [...new Set(input.pack.cases.flatMap(item => item.requiredTools))],
      supportedTaskModes: ["single_turn"],
      querySubjectRefs: scenario?.querySubjectRefs,
      seedTasks: input.pack.cases.map(({ name, prompt, requiredTools }) => ({ name, prompt: requiredTools.length && !input.pack.metadata.generationContext ? prompt : "", requiredTools })),
    },
  });
  return {
    source: "ai_generated",
    summary: result.summary,
    cases: result.cases,
    fingerprint: fingerprint(result.cases),
    generatedAt: new Date().toISOString(),
    generationId: input.generationId,
    model: input.model,
    skillArtifactSha256: input.skill.artifactSha256,
    sourceFiles: ["SKILL.md", ...Object.keys(references)],
  };
}
