import {createCriterionJudge} from '../../../agents/criterion-judge.js';
import { canonicalSha256 } from '../../../shared/json-canonicalization.js';
import { operationalEvent } from '../../../service/logging.js';
import { operationalError } from '../../../shared/operational-error.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectPreparationSchema, projectExecutionReceiptSchema } from '../domain/project-preparation.js';
import {fingerprint} from '../../../contracts.js';
import {correctModelOutput} from '../../../agents/model-output-correction.js';
import {taskDiagnosisSchema} from '../domain/task-diagnosis.js';
import {standardizationSchema,enterprisePolicy,standardizationExample,conformanceSchema,contractEvidenceSchema} from '../domain/task-standardization.js';
import {reusePlanningPolicy,reuseVerificationPolicy,skillInstructionBoundaryPolicy} from '../../domain/migration-reuse-policy.js';
import {
  runMigrationAgent,
  migrationAgentEnabled,
  migrationProjectRoot,
  agentIterations,
} from '../../infrastructure/migration-agent-runner.js';
import { configuredModelRole, modelTimeoutMs } from '../../../service/config.js';
import { analysisSchema, migrationPlanSchema, bundleError, deliverySchema } from '../domain/task-model.js';
import type { BundleAgent, BundleJudge } from '../application/task-ports.js';
import { loadAgentRole, compositionReceipt, type AgentRoleId } from '../../../agents/composition.js';
async function checkedAgentOutput<T>(value:unknown,schema:z.ZodType<T,z.ZodTypeDef,unknown>,fields:string[],input:Parameters<BundleAgent>[0]):Promise<T>{
  const checked=schema.safeParse(value);
  if(checked.success)return checked.data;
  const role=configuredModelRole('MIGRATION');
  const corrected=await correctModelOutput({raw:JSON.stringify(value??null),adapter:role.adapter,model:role.model,
    requestId:input.correlation?.agentRunId??randomUUID(),signal:input.signal,maxRepairs:1,
    check(candidate){const parsed=schema.safeParse(candidate);return parsed.success?{ok:true,value:parsed.data}:{ok:false,errors:parsed.error.issues.map(issue=>issue.path.join('.')+': '+issue.message)};},
    preserve(original,repaired){
      if(!original||!repaired||typeof original!=='object'||typeof repaired!=='object')return false;
      const before=original as Record<string,unknown>,after=repaired as Record<string,unknown>;
      return fields.every(field=>before[field]!==undefined&&fingerprint(before[field])===fingerprint(after[field]));
    }});
  if(!corrected.ok)bundleError('Agent 交付说明格式不符合合同，未重复执行代码生成：'+corrected.error);
  operationalEvent('migration_agent_output_corrected',{...input.correlation,outputCorrectionAttempts:corrected.repairs});
  return corrected.value;
}
export const runBundleAgent: BundleAgent = async (input) => {
  if (!migrationAgentEnabled()) bundleError('请先配置迁移 Agent；整组迁移不会回退为逐个独立生成');
  const runRole = async (request:Parameters<typeof runMigrationAgent>[1], options:Parameters<typeof runMigrationAgent>[2]) => {
    input.signal.throwIfAborted();
    const mode = (request.bundle as { mode: string }).mode;
    const roles: Record<string, AgentRoleId> = { PREPARE: 'runtime-preparation', ANALYZE: 'diagnosis', GENERATE: 'migration', REPAIR: 'migration', REVIEW: 'standardization-review' };
    const adjustmentCapabilities=(request.bundle as {adjustmentCapabilities?:Array<'document'|'tool'|'runtime'>}).adjustmentCapabilities;
    if(adjustmentCapabilities&&mode!=='REPAIR')throw new Error('Adjustment requires REPAIR mode');
    const role = adjustmentCapabilities?'adjustment':roles[mode];
    if (!role) throw new Error('Unknown migration role');
    const version = input.roleVersion ?? (process.env.FINANCE_EVAL_AGENT_ROLE_VERSION?.trim() || 'v1');
    const definition = loadAgentRole(role, version,adjustmentCapabilities?{execution:'engineering',capabilities:adjustmentCapabilities}:undefined);
    // Save the intended composition before starting, so cancellation/timeouts also have provenance.
    await input.onComposition?.(compositionReceipt(definition, { bundle: request.bundle, files: request.files },
      { modelId: options.modelId, providerId: options.providerId ?? 'service-execution' },
      { kind: 'agentIterations', maxIterations: options.maxIterations, timeoutMs: options.modelTimeoutMs ?? modelTimeoutMs('MIGRATION') }));
    input.signal.throwIfAborted();
    const result = await runMigrationAgent(role as 'runtime-preparation'|'diagnosis'|'migration'|'adjustment'|'standardization-review', { ...request, agentRoleVersion: version }, options);
    if (result.run?.composition) await input.onComposition?.(result.run.composition);
    return result;
  };
  const result = await runRole(
    {
      assetDigest: input.base.digest,
      runId: input.correlation?.agentRunId ?? randomUUID(),
      correlation: input.correlation,
      files: input.base.files,
      bundle: {
        mode: input.mode,
        project: input.project,
        ...(input.adjustmentCapabilities?{adjustmentCapabilities:input.adjustmentCapabilities}:{}),
        validateResult:true,
        source: input.source,
        base: { digest: input.base.digest, members: input.base.members },
        goal: input.goal,
        target: input.target,
        analysis: input.analysis,
        clarification: input.clarification,
        feedback: input.feedback,
        ...(input.mode === 'PREPARE' ? {} : {standardizationGuide:{policy:enterprisePolicy,planning:reusePlanningPolicy,verification:reuseVerificationPolicy,skill:skillInstructionBoundaryPolicy,
          example:standardizationExample}}),
      },
    },
    {
      projectRoot: migrationProjectRoot(),
      modelId: process.env.FINANCE_EVAL_AGENT_MODEL_ID?.trim() || 'enterprise-model',
      maxIterations: agentIterations('migration'),
      signal: input.signal,
    },
  );
  const payload = result.payload.judgement as Record<string, unknown>;
  if (result.status === 'ABSTAINED')
    return { status: 'ABSTAINED', reason: String(payload.reason ?? '需要补充迁移信息') };
  if (result.status !== 'PRODUCED') bundleError(result.run?.error ?? '整组迁移 Agent 未完成');
  if (input.mode === 'PREPARE') return {status: 'PRODUCED',
    preparation: projectPreparationSchema.parse(payload.preparation),
    executions: z.array(projectExecutionReceiptSchema).parse(payload.executions ?? []), files: result.payload.files};
  if(input.mode==='ANALYZE' && (!payload.analysis || typeof payload.analysis!=='object' || !('plan' in payload.analysis)))
    bundleError('Agent 未返回完整迁移方案，请重新诊断；不会根据摘要补造方案。');
  if(input.mode==='ANALYZE' && !('diagnosis' in (payload.analysis as object)))
    bundleError('Agent 未返回逐项工具诊断与改造内容，请重新诊断；不会根据摘要编造工具方案。');
  if(input.mode==='ANALYZE')return {status:'PRODUCED',analysis:await checkedAgentOutput(payload.analysis,
    analysisSchema.extend({plan:migrationPlanSchema,diagnosis:taskDiagnosisSchema,standardization:standardizationSchema}),
    ['summary','changes','missing','plan','diagnosis','standardization'],input)};
  const delivery=await checkedAgentOutput(payload.delivery,deliverySchema,['summary','services',...(input.analysis?.standardization?['tools']:[])],input);
  if(input.analysis?.standardization){
    if(!delivery.tools)bundleError('缺少 Script/MCP/CLI 工具交付清单');
    const hasDevelopmentEvidence = input.feedback != null && typeof input.feedback === 'object' && 'cases' in input.feedback;
    const review=await runRole({assetDigest:input.base.digest,runId:randomUUID(),correlation:input.correlation,
      files:result.payload.files,bundle:{mode:'REVIEW',validateResult:true,source:input.source,base:{members:input.base.members},analysis:input.analysis,delivery,
        standardizationGuide:{reviewStage:hasDevelopmentEvidence?'DEVELOPMENT_REPAIR':'MIGRATION_BASELINE',
          policy:enterprisePolicy,planning:reusePlanningPolicy,verification:reuseVerificationPolicy,skill:skillInstructionBoundaryPolicy}}},
      {projectRoot:migrationProjectRoot(),modelId:process.env.FINANCE_EVAL_AGENT_MODEL_ID?.trim()||'enterprise-model',maxIterations:agentIterations('standardization-review'),signal:input.signal});
    if(review.status!=='PRODUCED')bundleError('候选独立审查未完成，不能声明标准化通过');
    delivery.conformance=conformanceSchema.parse((review.payload.judgement as Record<string,unknown>).review);
    // Test receipts are emitted by the runner after the candidate is frozen, never authored by the model.
    delivery.contractEvidence=z.array(contractEvidenceSchema).parse(payload.contractEvidence??[]);
  }
  return {status:'PRODUCED',delivery,files:result.payload.files};
};
export const judgeBundleCase: BundleJudge = async (input) => {
  const role = configuredModelRole('JUDGE');
  if (!role.adapter) bundleError('请配置验收 Judge 模型后运行联合验收');
  const judgeRequestId = randomUUID();
  const context = { ...input.correlation, caseId: input.evalCase.caseId, judgeRequestId };
  operationalEvent('migration_judge_started', context);
  const started = Date.now();
  try {
    const result=await createCriterionJudge({adapter:role.adapter,model:role.model})(input,{
      requestId:judgeRequestId,signal:input.signal,timeoutMs:modelTimeoutMs('JUDGE'),onComposition:input.onComposition,
    });
    operationalEvent('migration_judge_finished',{...context,status:'COMPLETED',elapsedMs:Date.now()-started});
    return result;
  } catch (error) {
    operationalEvent('migration_judge_finished', { ...context, status: 'FAILED', elapsedMs: Date.now() - started, err: operationalError(error) });
    throw error;
  }
};

// Bind acceptance to the evaluator implementation and non-secret model configuration.
judgeBundleCase.timeoutMs = () => modelTimeoutMs('JUDGE');
judgeBundleCase.identity = () => canonicalSha256({
  protocol: 'finance.migration-judge.v1', policyRevision: 'separated-assessment-v1',
  compositionDigest:loadAgentRole('criterion-judge').definitionDigest,
  model: configuredModelRole('JUDGE').model,
  provider: process.env.FINANCE_EVAL_JUDGE_PROVIDER ?? 'openai-compatible',
  endpointDigest: canonicalSha256(process.env.FINANCE_EVAL_JUDGE_BASE_URL ?? process.env.FINANCE_EVAL_MODEL_BASE_URL ?? ''),
});
