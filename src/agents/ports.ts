import type { AgentCompositionReceipt } from '../shared/contracts/agent-composition.js';
import type {EffectReviewResult} from '../improvement/domain/effect-review.js';
export type {EffectReviewResult} from '../improvement/domain/effect-review.js';

export type AgentAbstention = { status: 'ABSTAINED'; reason: string };
export type RoleCallOptions = {
  requestId: string;
  signal?: AbortSignal;
  version?: string;
  timeoutMs?: number;
  onComposition?: (receipt: AgentCompositionReceipt) => Promise<void> | void;
};
export type SkillEditorInput = {
  constraints?: string;
  files: Record<string, string>;
  developmentEvidence: Array<{ task: string; answer: string; review?: string; dimensions?: unknown; goalAssessment?: unknown }>;
};
export type AdjustmentProposal = { summary: string; findings: string[]; changes: Array<{ path: string; content: string; reason: string }> };
/** Compatibility contract for the document-only entry, backed by the adjustment role. */
export type SkillEditorProposal = AdjustmentProposal;
export type SkillEditorResult = AgentAbstention | { status: 'PRODUCED'; proposal: SkillEditorProposal };
export type SkillEditor = (input: SkillEditorInput, options: RoleCallOptions) => Promise<SkillEditorResult>;

/** Caller selects development evidence; neither full reports nor holdout material are accepted. */
export type EffectReviewInput = {
  goal: string;
  baselineDigest: string;
  candidateDigest: string;
  incumbentDigest?:string;
  protectedCaseIds?:string[];
  targetPassRate?:number;
  remainingRounds?:number;
  contextChanges?:import('../improvement/domain/optimization-loop.js').OptimizationContextChange[];
  changes: Array<{ path: string; reason: string; before?:string;after?:string }>;
  evidence: Array<{ evidenceId: string; evaluationDigest: string; completed: boolean; comparable: boolean; summary: string; baseline?:unknown;candidate?:unknown;incumbent?:unknown }>;
};
export type EffectReviewer = (input: EffectReviewInput, options: RoleCallOptions) => Promise<EffectReviewResult>;
