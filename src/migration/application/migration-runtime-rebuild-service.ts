import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { capabilityRequirementSchema, withRequirementsDigest } from '../../shared/contracts/runtime-builder.js';
import { RUNTIME_CAPABILITIES_SCHEMA_VERSION, RUNTIME_EXECUTION_SCHEMA_VERSION, LEGACY_RUNTIME_INSTANCE_SCHEMA_VERSION, RUNTIME_OBSERVATION_SCHEMA_VERSION } from '../../shared/contracts/runtime-protocol-versions.js';
import { currentRuntimeRequirements } from '../domain/migration-runtime-requirements.js';
import { resolveMigrationEnvironment, type MigrationEnvironmentRepository } from './migration-environment-repository.js';
import type { MigrationEvaluationJobReader } from './migration-evaluation-ports.js';
import type { MigrationProjectStore } from './migration-project-store.js';
import { migrationConflict as conflict } from './migration-errors.js';
import type {SkillAssetRecord} from '../../shared/contracts/skill-asset.js';

const manualProposalSchema=z.strictObject({
  jobId:z.string().min(1),
  hypothesis:z.strictObject({id:z.string().min(1).max(200),issue:z.string().min(1).max(2000),expectedBehavior:z.string().min(1).max(2000)}),
  evidence:z.array(z.strictObject({caseId:z.string().min(1).optional(),summary:z.string().min(1).max(1000)})).min(1).max(20),
  requiredCapabilities:z.array(capabilityRequirementSchema).optional(),
});
const planProposalSchema=z.strictObject({
  planId:z.string().min(1),
  requiredCapabilities:z.array(capabilityRequirementSchema).min(1),
});

/** Records a reviewable Builder request grounded in a completed run and a deployed baseline. */
export class MigrationRuntimeRebuildService {
  constructor(private readonly projects:MigrationProjectStore,private readonly jobs:MigrationEvaluationJobReader,
    private readonly environments?:MigrationEnvironmentRepository){}

  async propose(id:string,input:unknown,experimentCandidate?:SkillAssetRecord){
    return this.projects.runExclusive(id,async()=>{
      const parsed=z.union([manualProposalSchema,planProposalSchema]).parse(input),project=await this.projects.get(id);
      const candidate=experimentCandidate??project.candidate;
      const plan='planId' in parsed?project.improvementPlans?.find(item=>item.planId===parsed.planId):null;
      if('planId' in parsed&&(!plan||plan.status!=='PROPOSED'||plan.hypothesis?.layer!=='HARNESS'))
        return conflict('只能依据当前有效的 Harness 改进规划请求 Builder 重建');
      const proposal='planId' in parsed?{
        jobId:plan!.sourceJobId,
        hypothesis:{id:plan!.planId,issue:plan!.hypothesis!.issue,expectedBehavior:plan!.hypothesis!.expectedBehavior},
        evidence:plan!.hypothesis!.evidenceCaseIds.map(caseId=>({caseId,summary:plan!.hypothesis!.issue.slice(0,1000)})),
        requiredCapabilities:parsed.requiredCapabilities,
      }:parsed;
      const experiment=project.runs.find(item=>item.jobId===proposal.jobId);
      const job=this.jobs.get(proposal.jobId);
      const baseline=experiment?.solutionRevisions?.right;
      if(!candidate||!experiment||experiment.candidateDigest!==candidate.artifactSha256||!baseline
        ||!job||job.status!=='completed'||!job.report?.cases.length)return conflict('请先对当前候选完成有方案版本记录的运行评测');
      if(plan&&(plan.candidateDigest!==candidate.artifactSha256||plan.baseSolutionRevisionId!==baseline.revisionId))
        return conflict('规划基线方案已变化，请重新评测并规划');
      if(!baseline.runtime.deploymentId||!baseline.runtime.artifactSha256)return conflict('基线不是 Builder 交付的 Launcher，不能提出重建请求');
      const selected=await resolveMigrationEnvironment(this.environments,baseline.runtime.environmentId);
      if(!selected||selected.launcher.delivery?.deploymentId!==baseline.runtime.deploymentId
        ||selected.launcher.delivery.artifactSha256!==baseline.runtime.artifactSha256)return conflict('基线 Launcher 已变化，请先重新评测');
      if(plan&&selected.launcher.baseUrl!==baseline.runtime.endpoint)return conflict('规划使用的 Launcher 执行地址已变化，请重新评测');
      const caseIds=new Set(job.report.cases.map(item=>item.caseId));
      if(proposal.evidence.some(item=>item.caseId&&!caseIds.has(item.caseId)))return conflict('重建依据必须引用本轮实际执行的案例');
      const evidence=plan?proposal.evidence.map(item=>{
        const observed=job.report!.cases.find(entry=>entry.caseId===item.caseId)!;
        const calls=observed.right.toolCalls.slice(0,12).map(call=>`${call.name}:${call.status}`).join(', ')||'no tool calls';
        return {caseId:item.caseId,summary:`Runtime ${observed.right.status}; tool calls: ${calls}`.slice(0,1000)};
      }):proposal.evidence;
      const current=currentRuntimeRequirements(project);
      const inherited=current&&'requestId' in current?current.requiredCapabilities:[];
      const requiredCapabilities=proposal.requiredCapabilities??inherited;
      const requirements=withRequirementsDigest({
        schemaVersion:'finance.runtime-build-requirements.v1',
        requestId:`${id}:rebuild:${randomUUID()}`,
        source:{assetId:candidate.assetId,artifactSha256:candidate.artifactSha256},
        target:{runtimeType:selected.launcher.runtimeType,protocols:{capabilities:RUNTIME_CAPABILITIES_SCHEMA_VERSION,
          instance:LEGACY_RUNTIME_INSTANCE_SCHEMA_VERSION,execution:RUNTIME_EXECUTION_SCHEMA_VERSION,observation:RUNTIME_OBSERVATION_SCHEMA_VERSION}},
        requiredCapabilities,
        rebuild:{baseline:{deploymentId:baseline.runtime.deploymentId,artifactSha256:baseline.runtime.artifactSha256,solutionRevisionId:baseline.revisionId},
          hypothesis:proposal.hypothesis,evidence:evidence.map(item=>({jobId:proposal.jobId,...item}))},
      });
      (project.runtimeRebuilds??=[]).push({candidateDigest:candidate.artifactSha256,requirements,createdAt:new Date().toISOString()});
      await this.projects.save(project);
      return requirements;
    });
  }
}
