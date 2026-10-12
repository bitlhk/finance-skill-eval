import { describe, expect, it, vi } from "vitest";
import {
  DirectModelRuntimeAdapter,
  type ModelAdapter,
} from "../src/index.js";

const model: ModelAdapter = {
  adapterId: "test-model",
  complete: vi.fn(async request => ({
    content: request.messages[0]?.content.includes("本轮已装配") ? "Skill answer" : "Baseline answer",
    modelId: request.model.modelId,
  })),
};

describe("DirectModelRuntimeAdapter", () => {
  it("keeps the model and task fixed while changing Skill instructions", async () => {
    const runtime = new DirectModelRuntimeAdapter({
      modelAdapter: model,
      resolveSkill: async variant => variant.mode === "skill_version" ? {
        skillId: variant.skillId,
        version: variant.version,
        artifactSha256: "a".repeat(64),
        instructions: "Use a professional decision structure.",
      } : null,
    });
    const base = {
      runId: "run-1",
      evalCase: {
        caseId: "CASE-1",
        name: "Text task",
        taskMode: "single_turn" as const,
        prompt: "Produce a review.",
        evaluationGoal: "Compare quality.",
        requiredTools: [],
        rubric: [{
          criterionId: "quality",
          label: "Quality",
          description: "Professional output",
          dimension: "professional_fit" as const,
          weight: 1,
          required: true,
          allOf: [],
          anyOf: [],
          noneOf: [],
        }],
      },
      model: { providerId: "test", modelId: "same-model", parameters: {} },
    };
    const left = await runtime.execute({
      ...base,
      side: "left",
      variant: { mode: "without_target_skill", skillId: "test-skill" },
    });
    const right = await runtime.execute({
      ...base,
      side: "right",
      variant: { mode: "skill_version", skillId: "test-skill", version: "1.0.0" },
    });

    expect(left.modelId).toBe(right.modelId);
    expect(left.loadedSkills).toEqual([]);
    expect(right.loadedSkills).toEqual([{ skillId: "test-skill", version: "1.0.0" }]);
    expect(left.runtimeIdentityVerified).toBe(true);
    expect(right.runtimeIdentityVerified).toBe(true);
  });

  it("rejects tool-dependent cases instead of simulating tool execution", async () => {
    const runtime = new DirectModelRuntimeAdapter({ modelAdapter: model, resolveSkill: async () => null });
    await expect(runtime.execute({
      runId: "run-2",
      side: "left",
      evalCase: {
        caseId: "CASE-2",
        name: "Tool task",
        taskMode: "single_turn",
        prompt: "Query an account.",
        evaluationGoal: "Use evidence.",
        requiredTools: ["account_query"],
        rubric: [{
          criterionId: "evidence",
          label: "Evidence",
          description: "Uses account data",
          dimension: "professional_fit",
          weight: 1,
          required: true,
          allOf: [],
          anyOf: [],
          noneOf: [],
        }],
      },
      model: { providerId: "test", modelId: "same-model", parameters: {} },
      variant: { mode: "without_target_skill", skillId: "test-skill" },
    })).rejects.toThrow("cannot execute required tools");
  });

  it("executes a tool-dependent prompt as an explicit tool-less baseline", async () => {
    const runtime = new DirectModelRuntimeAdapter({ modelAdapter: model, resolveSkill: async () => null,allowToollessBaseline:true,
      executionModel:{providerId:'service-execution',modelId:'upstream-model'} });
    const result=await runtime.execute({runId:'run-3',side:'left',model:{providerId:'test',modelId:'same-model',parameters:{temperature:0}},
      variant:{mode:'without_target_skill',skillId:'test-skill'},evalCase:{caseId:'CASE-3',name:'Tool baseline',taskMode:'single_turn',
        prompt:'Query an account.',evaluationGoal:'Do not invent data.',requiredTools:['account_query'],rubric:[{criterionId:'truth',label:'Truth',description:'No fabrication',dimension:'professional_fit',weight:1,required:true,allOf:[],anyOf:[],noneOf:[]}]}});
    expect(result.status).toBe('completed');
    expect(result.toolCalls).toEqual([]);
    expect(result.metadata).toMatchObject({executionMode:'direct-model',toolExecutionSupported:false,
      installedToolInventory:{status:'COMPLETE',tools:[]},toolAttemptEvidence:{status:'COMPLETE',zeroCalls:true},
      configuredModelId:'upstream-model',comparisonModelId:'same-model'});
    expect(model.complete).toHaveBeenLastCalledWith(expect.objectContaining({model:expect.objectContaining({modelId:'upstream-model',parameters:{temperature:0}})}));
  });
});
