import {prepareModelRole} from './model-role.js';
import { z } from 'zod';
import type { ModelAdapter } from '../adapters.js';
import type { ModelRef } from '../contracts.js';
import { loadAgentRole } from './composition.js';
import type { EffectReviewer, RoleCallOptions, SkillEditor } from './ports.js';
import {boundedAgentCall} from './bounded-call.js';
import {createAdjustmentAgent} from './adjustment-agent.js';

const abstentionSchema = z.strictObject({ status: z.literal('ABSTAINED'), reason: z.string().trim().min(1) });
const documentPath = z.string().refine(value =>
  (value === 'SKILL.md' || /^references\/[a-zA-Z0-9_/-]+\.md$/u.test(value)) && !value.includes('..'), 'Document path outside editor scope');
export const skillEditorProposalSchema = z.strictObject({
  summary: z.string().min(1).max(4000), findings: z.array(z.string().max(1500)).min(1).max(8),
  changes: z.array(z.strictObject({ path: documentPath, content: z.string().min(1).max(80000), reason: z.string().min(1).max(2000) })).min(1).max(6),
}).refine(value => new Set(value.changes.map(c => c.path)).size === value.changes.length, 'Duplicate document path');
const editorInputSchema = z.strictObject({
  constraints: z.string().optional(), files: z.record(z.string()),
  developmentEvidence: z.array(z.strictObject({ task: z.string(), answer: z.string(), review: z.string().optional(),
    dimensions: z.unknown().optional(), goalAssessment: z.unknown().optional() })),
});
const reviewInputSchema = z.strictObject({
  goal: z.string().min(1), baselineDigest: z.string().min(1), candidateDigest: z.string().min(1),
  incumbentDigest:z.string().min(1).optional(),protectedCaseIds:z.array(z.string()).optional(),
  targetPassRate:z.number().min(0).max(1).optional(),remainingRounds:z.number().int().min(0).optional(),
  contextChanges:z.array(z.strictObject({beforeProtocolDigest:z.string(),afterProtocolDigest:z.string(),criteriaDigest:z.string(),reference:z.string().min(1),reason:z.string().min(1)})).optional(),
  changes: z.array(z.strictObject({ path: z.string(), reason: z.string(),before:z.string().optional(),after:z.string().optional() })),
  evidence: z.array(z.strictObject({ evidenceId: z.string().min(1), evaluationDigest: z.string().min(1),
    completed: z.boolean(), comparable: z.boolean(), summary: z.string().min(1),baseline:z.unknown().optional(),candidate:z.unknown().optional(),incumbent:z.unknown().optional() })),
});
const reviewSchema = z.union([abstentionSchema, z.strictObject({ status: z.literal('PRODUCED'), review: z.strictObject({
  recommendation: z.enum(['KEEP_CANDIDATE', 'CONTINUE_CANDIDATE', 'KEEP_BASELINE', 'INCONCLUSIVE']), reason: z.string().min(1),
  improvements: z.array(z.string()), regressions: z.array(z.string()), evidenceIds: z.array(z.string()).min(1),
  tradeoff:z.string().trim().min(1).optional(),nextFocus:z.array(z.string().trim().min(1)).optional(),
}) })]);
type Dependencies = { adapter: ModelAdapter; model: ModelRef };

/** One completion, no tool registry, no filesystem access, no business retry or candidate loop. */
async function completeRole(role: 'effect-review', input: unknown, options: RoleCallOptions, dependencies: Dependencies) {
  return boundedAgentCall(options,async signal=>{
    const composition=loadAgentRole(role,options.version);
    const roleCall=await prepareModelRole(composition,input,options,dependencies,signal);
    const completion=await roleCall.complete(input);
    return JSON.parse(completion.content.replace(/^```(?:json)?\s*|\s*```$/gu, '')) as unknown;
  });
}

export function createSkillEditor(dependencies: Dependencies): SkillEditor {
  const adjust=createAdjustmentAgent(dependencies);
  return async (input, options) => {
    const safeInput = editorInputSchema.parse(input);
    // Compatibility facade: the document entry grants only document permissions to the shared role.
    const result=await adjust({...safeInput,permissions:{documents:{skillPaths:['SKILL.md'],referencePrefixes:['references']}}},options);
    return result.status==='ABSTAINED'?result:{status:'PRODUCED',proposal:skillEditorProposalSchema.parse(result.proposal)};
  };
}

/** Available to #27's orchestration port. This executor never makes an adoption decision. */
export function createEffectReviewer(dependencies: Dependencies): EffectReviewer {
  return async (input, options) => {
    options.signal?.throwIfAborted();
    const safeInput = reviewInputSchema.parse(input);
    const ids = new Set(safeInput.evidence.map(e => e.evidenceId));
    if (ids.size !== safeInput.evidence.length) throw new Error('Duplicate review evidence');
    if (!ids.size || safeInput.evidence.some(e => !e.completed || !e.comparable))
      return { status: 'ABSTAINED', reason: '缺少已完成且可比的候选评测证据' };
    const result = reviewSchema.parse(await completeRole('effect-review', safeInput, options, dependencies));
    if (result.status === 'PRODUCED' && (new Set(result.review.evidenceIds).size !== result.review.evidenceIds.length
        || result.review.evidenceIds.some(id => !ids.has(id)))) throw new Error('Review cites unknown or duplicate evidence');
    return result;
  };
}
