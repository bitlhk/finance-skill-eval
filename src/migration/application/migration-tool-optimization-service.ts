import {createHash,randomUUID} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {z} from 'zod';
import {versionedMethod} from '../domain/migration-method-version.js';
import type {MigrationProjectStore} from './migration-project-store.js';
import type {MigrationSkillRepository} from './migration-skill-repository.js';
import type {MigrationTechnicalValidationWorkflow} from './migration-technical-validation-service.js';
import {migrationConflict as conflict} from './migration-errors.js';
import type {TechnicalValidation} from '../domain/migration-model.js';
import type {MigrationEvaluationJobReader} from './migration-evaluation-ports.js';
import type {SkillAssetRecord} from '../../shared/contracts/skill-asset.js';
import type {MigrationCandidateInspectionService} from './migration-candidate-inspection-service.js';
import type {ReuseDesign} from '../domain/migration-reuse-design.js';

const proposalSchema=z.strictObject({
  toolId:z.string().min(1),
  summary:z.string().min(1).max(2000),
  changes:z.array(z.strictObject({path:z.string().min(1),content:z.string().min(1).max(128000),reason:z.string().min(1).max(2000)})).min(1).max(3),
});
export type ToolOptimizationProposal=z.infer<typeof proposalSchema>;
export type ToolOptimizationInput={planId:string;toolIds:string[];hypothesis:string;approvedReuseDesign?:ReuseDesign;
  files:Record<string,string>;developmentEvidence:Array<{caseId:string;task:string;runtimeStatus:string;
    toolCalls:Array<{name:string;status:string}>;review:string|null}>};
export type ToolOptimizationProposer=(input:ToolOptimizationInput,signal?:AbortSignal)=>Promise<unknown>;
const editable=/\.(?:py|js|mjs|cjs|ts|java|json|toml|ya?ml|txt)$/iu;
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Tool code is a separate immutable experiment. Only a passing technical check can make it active. */
export class MigrationToolOptimizationService{
  constructor(private readonly projects:MigrationProjectStore,private readonly skills:MigrationSkillRepository,
    private readonly technical:MigrationTechnicalValidationWorkflow,private readonly proposer:ToolOptimizationProposer,
    private readonly jobs:MigrationEvaluationJobReader,private readonly candidateInspection?:MigrationCandidateInspectionService){}

  async propose(id:string,input:unknown,experimentCandidate?:SkillAssetRecord,signal?:AbortSignal){
    signal?.throwIfAborted();
    const {planId}=z.strictObject({planId:z.string().min(1)}).parse(input);
    const project=await this.projects.get(id),base=experimentCandidate??project.candidate;
    const activeAssetId=project.candidate?.assetId;
    const plan=project.improvementPlans?.find(item=>item.planId===planId);
    if(!base||!plan||plan.status!=='PROPOSED'||plan.hypothesis?.layer!=='TOOL'||plan.candidateDigest!==base.artifactSha256)
      return conflict('Tool 改进规划与当前候选不匹配');
    if((project.toolOptimizationAttempts??[]).filter(item=>item.planId===planId).length>=3)
      return conflict('当前 Tool 假设的尝试次数已达上限');
    const allowedIds=plan.hypothesis.toolIds?.length?plan.hypothesis.toolIds:project.inspection?.tools.map(tool=>tool.toolId)??[];
    const generations=(project.portableGenerations??[]).filter(item=>allowedIds.includes(item.toolId)&&item.readyForValidation);
    if(!generations.length)return conflict('规划未指向可验证的已生成 Tool');
    const allowedPaths=new Set(generations.flatMap(item=>item.files).filter(path=>editable.test(path)&&path!==base.skillFile));
    const archive=await this.skills.readArchive(base.assetId);
    const files:Record<string,string>={};let size=0;
    for(const path of allowedPaths){
      const bytes=archive[path];if(!bytes)continue;
      const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      size+=content.length;if(size>160000)return conflict('Tool 文件太大，需缩小改进范围');
      files[path]=content;
    }
    if(!Object.keys(files).length)return conflict('没有可供优化的 Tool 文本文件');
    const run=project.runs.find(item=>item.jobId===plan.sourceJobId);
    const report=this.jobs.get(plan.sourceJobId)?.report;
    if(!run?.suiteSnapshot||!report)return conflict('缺少对应开发集运行证据');
    const developmentEvidence=report.cases.filter(item=>plan.developmentCaseIds.includes(item.caseId))
      .map(item=>({caseId:item.caseId,task:item.prompt.slice(0,4000),runtimeStatus:item.right.status,
        toolCalls:item.right.toolCalls.map(call=>({name:call.name,status:call.status})).slice(0,30),
        review:item.judge?.summary.slice(0,2000)??null}));
    const proposal=proposalSchema.parse(await this.proposer({planId,toolIds:generations.map(item=>item.toolId),
      hypothesis:plan.hypothesis.issue,files,developmentEvidence,
      ...(project.reuseProposal?.approvedAt?{approvedReuseDesign:project.reuseProposal.design}:{})},signal));
    signal?.throwIfAborted();
    if(!generations.some(item=>item.toolId===proposal.toolId))return conflict('Tool 提案引用了规划之外的工具');
    const ownPaths=new Set(generations.find(item=>item.toolId===proposal.toolId)!.files);
    const changed=new Set<string>();
    for(const change of proposal.changes){
      if(changed.has(change.path)||!ownPaths.has(change.path)||!(change.path in files)||!editable.test(change.path)
        ||change.path===base.skillFile||files[change.path]===change.content)return conflict('Tool 提案只能修改目标工具已有的文本实现文件');
      changed.add(change.path);
    }
    const attemptId=`tool-optimization-${randomUUID()}`;
    for(const change of proposal.changes)archive[change.path]=strToU8(change.content);
    archive[base.skillFile]=strToU8(versionedMethod(new TextDecoder().decode(archive[base.skillFile]!),base.skillId,
      `${base.version}-tool.${attemptId.slice(-8)}`));
    const candidate=await this.skills.uploadZip(Buffer.from(zipSync(archive)));
    if(candidate.artifactSha256===base.artifactSha256)return conflict('Tool 提案没有产生新资产');
    const validations:TechnicalValidation[]=[];
    for(const tool of project.inspection?.tools??[]){
      signal?.throwIfAborted();
      validations.push(await this.technical.validateIsolated(id,candidate,tool.toolId,signal));
    }
    const status=validations.length>0&&validations.every(item=>item.status==='PASSED')?'TECHNICAL_PASSED':'TECHNICAL_FAILED';
    const attempt={attemptId,planId,baseAssetId:base.assetId,candidate,toolId:proposal.toolId,
      summary:proposal.summary,changedPaths:[...changed],changes:proposal.changes.map(item=>({path:item.path,
        beforeSha256:sha256(files[item.path]!),afterSha256:sha256(item.content),reason:item.reason})),
      validations,status,createdAt:new Date().toISOString()} as const;
    await this.projects.runExclusive(id,async()=>{
      const current=await this.projects.get(id);
      if(current.candidate?.assetId!==activeAssetId)return conflict('技术验证期间候选已变化，请重新规划');
      (current.toolOptimizationAttempts??=[]).push({...attempt,validations:[...validations],changedPaths:[...changed]});
      await this.projects.save(current);
    });
    return attempt;
  }

  async adopt(id:string,input:unknown){
    const {attemptId}=z.strictObject({attemptId:z.string().min(1)}).parse(input);
    return this.projects.runExclusive(id,async()=>{
      const project=await this.projects.get(id),attempt=project.toolOptimizationAttempts?.find(item=>item.attemptId===attemptId);
      if(!attempt||attempt.status!=='TECHNICAL_PASSED'||project.candidate?.assetId!==attempt.baseAssetId)
        return conflict('仅能采用基于当前候选且技术验证全部通过的 Tool 试验');
      const actual=await this.skills.get(attempt.candidate.assetId);
      if(!actual||actual.artifactSha256!==attempt.candidate.artifactSha256)return conflict('Tool 试验资产已丢失或发生变化');
      const check=await this.technical.currentState({...project,candidate:actual,technicalValidations:attempt.validations});
      if(!check.ready)return conflict(`Tool 试验的技术验证已失效：${check.reasons.join('；')}`);
      if(project.reuseProposal){
        if(!this.candidateInspection)return conflict('迁移方案审查服务不可用');
        project.inspection=await this.candidateInspection.inspectRevision(project,actual);
        project.decisions=(project.decisions??[]).map(item=>item.baseAssetId===attempt.baseAssetId?{...item,baseAssetId:actual.assetId}:item);
      }
      project.candidate=actual;
      project.candidateNotes=`Tool 优化 ${attempt.attemptId}: ${attempt.summary}`;
      (project.candidateHistory??=[]).push({asset:actual,notes:project.candidateNotes,recordedAt:new Date().toISOString(),kind:'optimization'});
      (project.technicalValidations??=[]).push(...attempt.validations);
      attempt.status='ADOPTED';
      await this.projects.save(project);
      return project;
    });
  }
}
