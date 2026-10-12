import type {
  ModelAdapter,
  RuntimeAdapter,
  RuntimeExecutionRequest,
} from "./adapters.js";
import { fingerprint, type ModelRef, type RuntimeExecutionEvidence } from "./contracts.js";

export type ResolvedSkillSource = {
  skillId: string;
  version: string;
  artifactSha256: string;
  instructions: string;
  files?: Record<string, string>;
  canonicalArchive?: string;
  archiveBase64?:string;
  archiveSha256?:string;
};

export type DirectModelRuntimeOptions = {
  adapterId?: string;
  modelAdapter: ModelAdapter;
  resolveSkill(variant: RuntimeExecutionRequest["variant"]): Promise<ResolvedSkillSource | null>;
  allowToollessBaseline?: boolean;
  executionModel?:ModelRef;
};

/**
 * Reference runtime for text-only Skills. Tool-dependent cases must use an Agent Runtime adapter.
 */
export class DirectModelRuntimeAdapter implements RuntimeAdapter {
  readonly adapterId: string;

  constructor(private readonly options: DirectModelRuntimeOptions) {
    this.adapterId = options.adapterId ?? "direct-model-skill-runtime-v1";
  }

  async execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionEvidence> {
    if (request.evalCase.requiredTools.length > 0
      && !(this.options.allowToollessBaseline && request.variant.mode === "without_target_skill")) {
      throw new Error(
        `Direct model runtime cannot execute required tools: ${request.evalCase.requiredTools.join(", ")}`,
      );
    }
    const startedAt = Date.now();
    const skill = await this.options.resolveSkill(request.variant);
    if (request.variant.mode === "skill_version" && !skill) {
      throw new Error(
        `Skill artifact is unavailable: ${request.variant.skillId}@${request.variant.version}`,
      );
    }
    const executionModel=this.options.executionModel
      ? {...this.options.executionModel,parameters:request.model.parameters}
      : request.model;
    const completion = await this.options.modelAdapter.complete({
      requestId: `${request.runId}-${request.side}-${request.evalCase.caseId}`,
      model: executionModel,
      signal: request.signal,
      messages: [
        {
          role: "system",
          content: [
            "你正在完成一项金融岗位任务。只使用题面已提供的事实，不补造当前数据。",
            "输出应体现专业判断、业务完整性、清晰度和可执行性。",
            skill
              ? `以下是本轮已装配并必须遵循的 Skill：\n<skill>\n${skill.instructions}\n</skill>`
              : this.options.allowToollessBaseline
                ? "本轮是裸模型基线：未装配目标 Skill，也没有注册任何业务工具。若任务依赖外部数据，必须明确说明无法核验，不得编造工具结果。"
                : "本轮不装配目标 Skill，按模型自身能力完成任务。",
          ].join("\n\n"),
        },
        { role: "user", content: request.evalCase.prompt },
      ],
    });
    const loadedSkills = skill ? [{ skillId: skill.skillId, version: skill.version }] : [];
    const body = {
      caseId: request.evalCase.caseId,
      side: request.side,
      modelId: completion.modelId,
      output: completion.content,
      loadedSkills,
      usage: completion.usage ?? null,
    };
    return {
      runId: request.runId,
      side: request.side,
      caseId: request.evalCase.caseId,
      status: "completed",
      modelId: completion.modelId,
      skillVersion: skill?.version ?? null,
      output: completion.content,
      elapsedMs: Date.now() - startedAt,
      toolCalls: [],
      loadedSkills,
      usage: completion.usage ?? null,
      runtimeIdentityVerified: request.variant.mode === "without_target_skill" || Boolean(skill),
      streamCompleted: true,
      error: null,
      traceFingerprint: fingerprint(body),
      metadata: {
        executionMode: "direct-model",
        runtime:{type:"direct_model",version:"service-config"},
        skillArtifactSha256: skill?.artifactSha256 ?? null,
        toolExecutionSupported: false,
        installedToolInventory:{status:"COMPLETE",tools:[]},
        toolAttemptEvidence:{status:"COMPLETE",zeroCalls:true,scope:"DIRECT_MODEL_HAS_NO_TOOL_INTERFACE"},
        resourceLifecycle:{status:"NOT_APPLICABLE",reason:"DIRECT_MODEL_DOES_NOT_CREATE_RUNTIME_INSTANCE"},
        declaredModelParameters:request.model.parameters??{},
        configuredModelId:executionModel.modelId,
        comparisonModelId:request.model.modelId,
        modelParametersVerified:false,
      },
    };
  }
}
