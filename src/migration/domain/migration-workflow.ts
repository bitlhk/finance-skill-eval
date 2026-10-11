import type { MigrationProject } from './migration-project.js';
import type { MigrationPlan } from './migration-model.js';

export type MigrationWorkflowStage =
  | 'DIAGNOSE'
  | 'GENERATE'
  | 'ADAPT_RUNTIME'
  | 'VALIDATE_TECHNICAL'
  | 'EVALUATE'
  | 'EXPORT';

export type MigrationWorkflowAction =
  | 'INSPECT'
  | 'SAVE_DECISIONS'
  | 'GENERATE'
  | 'DOWNLOAD_RUNTIME_REQUIREMENTS'
  | 'VALIDATE_TECHNICAL'
  | 'EVALUATE'
  | 'EXPORT';

export type MigrationWorkflow = {
  stage: MigrationWorkflowStage;
  /** Index in the UI's stable seven-step navigation. */
  furthestStage: 1 | 2 | 3 | 4 | 5 | 6;
  allowedActions: MigrationWorkflowAction[];
  blockers: string[];
};

type WorkflowEvidence = {
  migrationPlan: MigrationPlan | null;
  runtimeRequirementsPending: boolean;
  technicalReady: boolean;
  evaluationCompleted: boolean;
};

/**
 * Derives navigation and commands from persisted evidence. It deliberately does not persist a
 * mutable "current step": refreshing the page must reconstruct the same workflow state.
 */
export function migrationWorkflow(project: MigrationProject, evidence: WorkflowEvidence): MigrationWorkflow {
  const pending=project.generationAttempts?.at(-1);
  if(pending&&pending.progress.status!=='COMPLETED'&&pending.baseAssetId===(project.candidate??project.source).assetId
    &&pending.proposalId===evidence.migrationPlan?.reuseProposal?.proposalId){
    return {stage:'GENERATE',furthestStage:2,allowedActions:['INSPECT','SAVE_DECISIONS','GENERATE'],
      blockers:[pending.progress.failure?.message??'候选生成与检查尚未完成']};
  }
  if(project.candidate&&project.nativeBindings?.candidateDigest===project.candidate.artifactSha256){
    return {stage:evidence.evaluationCompleted?'EXPORT':'EVALUATE',furthestStage:evidence.evaluationCompleted?6:5,
      allowedActions:['EVALUATE','EXPORT'],blockers:evidence.evaluationCompleted?[]:['已绑定准入工具；本候选尚需实际执行与业务效果验证']};
  }
  if (!project.inspection) {
    return { stage: 'DIAGNOSE', furthestStage: 1, allowedActions: ['INSPECT'], blockers: ['尚未完成 Skill 与 Tool 检查'] };
  }
  if (!evidence.migrationPlan?.generationAllowed) {
    return { stage: 'DIAGNOSE', furthestStage: 1, allowedActions: ['INSPECT', 'SAVE_DECISIONS'], blockers: evidence.migrationPlan?.skillBlockingReasons ?? ['迁移方案尚未完成'] };
  }
  const proposalChanged=!!evidence.migrationPlan.reuseProposal&&project.candidateReuseProposalId!==evidence.migrationPlan.reuseProposal.proposalId;
  if (!project.candidate || proposalChanged
    || project.portableGenerations?.some(item => !item.readyForValidation)) {
    return { stage: 'GENERATE', furthestStage: 2, allowedActions: ['INSPECT', 'SAVE_DECISIONS', 'GENERATE'],
      blockers: project.candidate ? [proposalChanged?'迁移方案已更新，请按本版方案生成并审查候选':'候选仍有待实现的 Tool'] : [] };
  }
  if (evidence.runtimeRequirementsPending) {
    return { stage: 'ADAPT_RUNTIME', furthestStage: 3, allowedActions: ['GENERATE', 'DOWNLOAD_RUNTIME_REQUIREMENTS', 'EXPORT'], blockers: ['请核对已有 Runtime 能力；不满足时由 Builder 适配后接入'] };
  }
  if (!evidence.technicalReady) {
    return { stage: 'VALIDATE_TECHNICAL', furthestStage: 4, allowedActions: ['GENERATE', 'VALIDATE_TECHNICAL', 'EXPORT'], blockers: ['当前候选尚未通过全部 Tool 技术验证'] };
  }
  if (!evidence.evaluationCompleted) {
    return { stage: 'EVALUATE', furthestStage: 5, allowedActions: ['VALIDATE_TECHNICAL', 'EVALUATE', 'EXPORT'], blockers: ['当前候选尚未完成业务效果评测'] };
  }
  return { stage: 'EXPORT', furthestStage: 6, allowedActions: ['VALIDATE_TECHNICAL', 'EVALUATE', 'EXPORT'], blockers: [] };
}
