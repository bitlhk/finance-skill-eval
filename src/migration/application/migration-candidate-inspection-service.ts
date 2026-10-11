import type {SkillAssetRecord} from '../../shared/contracts/skill-asset.js';
import type {PortableGeneration} from '../domain/migration-candidate-artifact.js';
import type {ProjectInspection,ToolDecision} from '../domain/migration-model.js';
import {inspectProject} from '../domain/migration-project-inspector.js';
import type {MigrationDiagnosisPort} from './migration-diagnosis-port.js';
import {migrationConflict as conflict} from './migration-errors.js';
import type {MigrationAnalyzer} from './migration-agent-port.js';
import type {MigrationAgentResultMapper} from './migration-agent-result-mapper.js';
import type {MigrationDependencyAnalyzer} from './migration-dependency-analyzer.js';
import type {MigrationReusePlanner} from './migration-reuse-planner.js';
import {currentReuseProposal,reuseReviewSchema,reuseReviewIssues,type MigrationReuseProposal} from '../domain/migration-reuse-design.js';
import type {MigrationProject} from '../domain/migration-project.js';
import type {MigrationSkillRepository} from './migration-skill-repository.js';
import type {MigrationSupplementRepository} from './migration-supplement-repository.js';
import type {ReusePlannerTelemetry} from '../domain/migration-reuse-telemetry.js';
import {MigrationGenerationError,type GenerationPhase,type MigrationGenerationAttempt} from '../domain/migration-generation-progress.js';
import {portableDeliveryContract} from '../domain/migration-delivery-contract.js';

export class MigrationCandidateInspectionService {
  constructor(private readonly diagnostics?:MigrationDiagnosisPort,private readonly analysis?:{
    analyzer:MigrationAnalyzer;results:MigrationAgentResultMapper;dependencies:MigrationDependencyAnalyzer;reusePlanner:MigrationReusePlanner;
    skills?:MigrationSkillRepository;supplements?:MigrationSupplementRepository;
  }) {}

  async sourceFiles(project:MigrationProject){
    if(!this.analysis?.skills)return conflict('缺少候选审查所需的源工程');
    const files=await this.analysis.skills.readArchive(project.source.assetId);
    const supplements=await this.analysis.supplements?.get(project.id);
    if(supplements&&(project.sourceInspection??project.inspection)?.dependencyAnalysis?.materialsDigest!==this.analysis.supplements!.digest(supplements))
      return conflict('补充材料已变化，请重新分析源工程并确认迁移方案');
    for(const item of supplements?.items??[])for(const [name,bytes] of Object.entries(item.files??{}))files[name]=Buffer.from(bytes,'base64');
    const sourceFiles:Record<string,string>={};
    for(const [name,bytes] of Object.entries(files))
      try{sourceFiles[name]=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{}
    return sourceFiles;
  }

  async inspectRevision(project:MigrationProject,candidate:SkillAssetRecord){
    if(!project.inspection||!this.analysis?.skills)return conflict('缺少候选审查所需的工程信息');
    const proposal=currentReuseProposal(project);
    if(project.reuseProposal&&!proposal?.approvedAt)return conflict('迁移方案已失效，请重新确认后采纳改进产物');
    return this.inspect({candidate,files:await this.analysis.skills.readArchive(candidate.assetId),inspection:project.inspection,
      decisions:project.decisions??[],baseAssetId:(project.candidate??project.source).assetId,generations:project.portableGenerations??[],
      reuseProposal:proposal??undefined,sourceInspection:project.sourceInspection??project.inspection,sourceFiles:await this.sourceFiles(project),sourceSkillFile:project.source.skillFile});
  }

  async inspect(input:{candidate:SkillAssetRecord;files:Record<string,Uint8Array>;inspection:ProjectInspection;
    decisions:ToolDecision[];baseAssetId:string;generations:PortableGeneration[];reuseProposal?:MigrationReuseProposal;sourceInspection?:ProjectInspection;sourceFiles?:Record<string,string>;sourceSkillFile?:string;
    onPhase?:(phase:GenerationPhase)=>unknown;
    checkpoint?:MigrationGenerationAttempt['inspectionCheckpoint'];
    saveCheckpoint?:(checkpoint:NonNullable<MigrationGenerationAttempt['inspectionCheckpoint']>)=>Promise<void>}):Promise<ProjectInspection>{
    const decoded:Record<string,string>={};
    for(const [name,bytes] of Object.entries(input.files)){try{decoded[name]=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{}}
    if(!this.diagnostics||!this.analysis)return conflict('候选分析服务不可用，不能确认生成候选');
    const checkpoint=structuredClone(input.checkpoint??{});
    const save=async()=>input.saveCheckpoint?.(structuredClone(checkpoint));
    const blocked=(phase:GenerationPhase,code:string,message:string):never=>{throw new MigrationGenerationError({phase,code,message,recoverable:false})};
    if([checkpoint.rules,checkpoint.analysis,checkpoint.inspection].some(value=>value&&(value.assetId!==input.candidate.assetId||value.assetDigest!==input.candidate.artifactSha256)))
      return blocked('PREPARING','CHECKPOINT_MISMATCH','候选检查点与实际资产不匹配，不能恢复');
    if(!checkpoint.rules){
    await input.onPhase?.('STATIC_SCAN');
    let diagnosis;
    try{diagnosis=await this.diagnostics.diagnose(input.candidate,false,{explain:false})}
    catch{throw new MigrationGenerationError({phase:'STATIC_SCAN',code:'STATIC_DIAGNOSIS_FAILED',recoverable:true,
      message:'生成候选的静态诊断执行失败，候选未被采纳；请检查 uv、锁文件和扫描器配置'})}
    if(diagnosis.digest!==input.candidate.artifactSha256)return conflict('生成候选的静态诊断与资产不匹配');
    const rules=inspectProject({assetId:input.candidate.assetId,assetDigest:input.candidate.artifactSha256,
      files:decoded,skillFile:input.candidate.skillFile,diagnosis});
    if(rules.skill.status!=='COMPLIANT')return blocked('STATIC_SCAN','SKILL_NON_COMPLIANT',
      `生成候选不符合 Skill 包规范：${rules.skill.findings.filter(finding=>finding.severity==='ERROR').slice(0,3).map(finding=>`${finding.path}:${finding.line} ${finding.message}`).join('；')}。请修改产物后重新检查`);
    checkpoint.rules={assetId:rules.assetId,assetDigest:rules.assetDigest,skill:rules.skill,staticAnalysis:rules.staticAnalysis};
    await save();
    }
    let inspection=checkpoint.inspection;
    if(!inspection){
    await input.onPhase?.('CANDIDATE_ANALYSIS');
    if(!checkpoint.analysis){
    const actual=await this.analysis.analyzer({assetDigest:input.candidate.artifactSha256,runId:`${input.candidate.assetId}-verify`,files:input.files,
      deliveryContract:portableDeliveryContract(input.sourceInspection??input.inspection,input.decisions.filter(d=>d.baseAssetId===input.baseAssetId),input.sourceSkillFile)});
    if(actual?.status==='ABSTAINED')return blocked('CANDIDATE_ANALYSIS','ANALYSIS_ABSTAINED','候选分析明确无法确认实际能力与依赖，请补充依据或修改产物');
    if(actual?.status!=='PRODUCED')return conflict('生成候选的实际能力与依赖未能重新确认，请查看分析记录');
    inspection=this.analysis.results.inspection({payload:actual.payload,assetId:input.candidate.assetId,
      assetDigest:input.candidate.artifactSha256,scanner:actual.scanner,files:decoded});
    inspection.skill=checkpoint.rules.skill;
    inspection.staticAnalysis=checkpoint.rules.staticAnalysis;
    inspection.dependencyAnalysis=this.analysis.dependencies.analyze({payload:actual.payload,inspection,files:decoded,
      supplements:[],revision:0,materialsDigest:input.candidate.artifactSha256,workspaceRoot:actual.workspaceRoot,libraryInventory:actual.libraryInventory});
    checkpoint.analysis=structuredClone(inspection);
    await save();
    }
    inspection=structuredClone(checkpoint.analysis);
    if(!inspection.dependencyAnalysis)return conflict('候选分析检查点缺少依赖结果，不能恢复');
    if(inspection.dependencyAnalysis.status!=='COMPLETE')return blocked('CANDIDATE_ANALYSIS','DEPENDENCIES_UNCONFIRMED','生成候选仍有未确认的实际依赖，不能按已确认方案采纳');
    const expectedNames=new Set(input.inspection.tools.map(tool=>tool.name));
    if(inspection.tools.length!==expectedNames.size||new Set(inspection.tools.map(tool=>tool.name)).size!==expectedNames.size
      ||inspection.tools.some(tool=>!expectedNames.has(tool.name)))return blocked('CANDIDATE_ANALYSIS','TOOLS_MISMATCH','候选业务工具与已确认方案不一致，请修正或重新确认接口改造方案');
    const actualToSource=new Map<string,string>();
    for(const tool of inspection.tools){
      const source=input.inspection.tools.find(item=>item.name===tool.name)!;
      const decision=input.decisions.find(item=>item.toolId===source.toolId&&item.baseAssetId===input.baseAssetId);
      const portable=decision?.form==='SCRIPT'?'PORTABLE_SCRIPT':'PORTABLE_MCP';
      if(!decision||tool.portability!==portable)return blocked('CANDIDATE_ANALYSIS','COUPLING_UNRESOLVED',`候选工具 ${tool.name} 尚未确认解除原运行框架耦合`);
      actualToSource.set(tool.toolId,source.toolId);
      tool.toolId=source.toolId;
      const generation=input.generations.find(item=>item.toolId===source.toolId);
      if(decision.form==='SCRIPT'&&generation?.entrypoint)tool.entrypoint={kind:decision.language==='node'?'NODE':'PYTHON',path:generation.entrypoint};
    }
    for(const dependency of inspection.dependencyAnalysis.dependencies)
      dependency.toolIds=dependency.toolIds.map(id=>actualToSource.get(id)??id);
    for(const chain of inspection.dependencyAnalysis.chains)chain.toolId=actualToSource.get(chain.toolId)??chain.toolId;
    checkpoint.inspection=inspection;
    await save();
    }
    const proposal=input.reuseProposal;
    if(proposal){
      if(!proposal.approvedAt||!input.sourceFiles)return conflict('缺少已确认方案及冻结源码，不能审查候选');
      if(inspection.reuseConformance?.proposalId===proposal.proposalId){
        const issues=reuseReviewIssues(inspection.reuseConformance.review,proposal.design,decoded);
        if(issues.length)return blocked('PLAN_REVIEW','DESIGN_NOT_IMPLEMENTED','候选未落实已确认迁移方案，需要修改产物或方案；不能重复审查覆盖这一结论');
        return inspection;
      }
      await input.onPhase?.('PLAN_REVIEW');
      const output=await this.analysis.reusePlanner({mode:'REVIEW',candidateFiles:decoded,sourceFiles:input.sourceFiles,
        deliveryContract:portableDeliveryContract(input.sourceInspection??input.inspection,input.decisions.filter(d=>d.baseAssetId===input.baseAssetId),input.sourceSkillFile),
        sourceInspection:input.sourceInspection??input.inspection,candidateInspection:inspection,design:proposal.design}) as {status?:string;review?:unknown;reason?:string;telemetry?:ReusePlannerTelemetry};
      if(output?.status!=='REVIEWED')return blocked('PLAN_REVIEW','REVIEW_ABSTAINED','候选方案审查未给出可确认结论，请补充依据或调整方案');
      const review=reuseReviewSchema.safeParse(output.review);
      if(!review.success)return conflict('候选审查结果结构不完整');
      const issues=reuseReviewIssues(review.data,proposal.design,decoded);
      inspection.reuseConformance={proposalId:proposal.proposalId,candidateDigest:input.candidate.artifactSha256,
        reviewedAt:new Date().toISOString(),review:review.data,acceptanceChecks:proposal.design.acceptanceChecks.map(check=>({checkId:check.id,status:'NOT_RUN'})),
        ...(output.telemetry?{telemetry:output.telemetry}:{})};
      checkpoint.inspection=inspection;
      await save();
      if(issues.length)return blocked('PLAN_REVIEW','DESIGN_NOT_IMPLEMENTED','候选未落实已确认迁移方案，需要修改产物或方案；不能重复审查覆盖这一结论');
    }
    return inspection;
  }
}
