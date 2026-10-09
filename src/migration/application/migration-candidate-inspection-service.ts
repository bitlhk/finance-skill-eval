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
import type {GenerationPhase} from '../domain/migration-generation-progress.js';
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
      reuseProposal:proposal??undefined,sourceInspection:project.sourceInspection??project.inspection,sourceFiles:await this.sourceFiles(project)});
  }

  async inspect(input:{candidate:SkillAssetRecord;files:Record<string,Uint8Array>;inspection:ProjectInspection;
    decisions:ToolDecision[];baseAssetId:string;generations:PortableGeneration[];reuseProposal?:MigrationReuseProposal;sourceInspection?:ProjectInspection;sourceFiles?:Record<string,string>;
    onPhase?:(phase:GenerationPhase)=>void}):Promise<ProjectInspection>{
    const decoded:Record<string,string>={};
    for(const [name,bytes] of Object.entries(input.files)){try{decoded[name]=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{}}
    if(!this.diagnostics||!this.analysis)return conflict('候选分析服务不可用，不能确认生成候选');
    input.onPhase?.('STATIC_SCAN');
    let diagnosis;
    try{diagnosis=await this.diagnostics.diagnose(input.candidate,false,{explain:false})}
    catch{return conflict('生成候选的静态诊断执行失败，候选未被采纳；请检查 uv、锁文件和扫描器配置')}
    if(diagnosis.digest!==input.candidate.artifactSha256)return conflict('生成候选的静态诊断与资产不匹配');
    const rules=inspectProject({assetId:input.candidate.assetId,assetDigest:input.candidate.artifactSha256,
      files:decoded,skillFile:input.candidate.skillFile,diagnosis});
    if(rules.skill.status!=='COMPLIANT')return conflict(`生成候选不符合 Skill 包规范：${rules.skill.findings.filter(item=>item.severity==='ERROR').map(item=>item.message).join('；')}`);
    input.onPhase?.('CANDIDATE_ANALYSIS');
    const actual=await this.analysis.analyzer({assetDigest:input.candidate.artifactSha256,runId:`${input.candidate.assetId}-verify`,files:input.files});
    if(actual?.status!=='PRODUCED')return conflict('生成候选的实际能力与依赖未能重新确认，请查看分析记录');
    const inspection=this.analysis.results.inspection({payload:actual.payload,assetId:input.candidate.assetId,
      assetDigest:input.candidate.artifactSha256,scanner:actual.scanner,files:decoded});
    inspection.skill=rules.skill;
    inspection.staticAnalysis=rules.staticAnalysis;
    inspection.dependencyAnalysis=this.analysis.dependencies.analyze({payload:actual.payload,inspection,files:decoded,
      supplements:[],revision:0,materialsDigest:input.candidate.artifactSha256,workspaceRoot:actual.workspaceRoot,libraryInventory:actual.libraryInventory});
    if(inspection.dependencyAnalysis.status!=='COMPLETE')return conflict('生成候选仍有未确认的实际依赖，不能按已确认方案采纳');
    const expectedNames=new Set(input.inspection.tools.map(tool=>tool.name));
    if(inspection.tools.length!==expectedNames.size||new Set(inspection.tools.map(tool=>tool.name)).size!==expectedNames.size
      ||inspection.tools.some(tool=>!expectedNames.has(tool.name)))return conflict('候选业务工具与已确认方案不一致，请修正或重新确认接口改造方案');
    const actualToSource=new Map<string,string>();
    for(const tool of inspection.tools){
      const source=input.inspection.tools.find(item=>item.name===tool.name)!;
      const decision=input.decisions.find(item=>item.toolId===source.toolId&&item.baseAssetId===input.baseAssetId);
      const portable=decision?.form==='SCRIPT'?'PORTABLE_SCRIPT':'PORTABLE_MCP';
      if(!decision||tool.portability!==portable)return conflict(`候选工具 ${tool.name} 尚未确认解除原运行框架耦合`);
      actualToSource.set(tool.toolId,source.toolId);
      tool.toolId=source.toolId;
      const generation=input.generations.find(item=>item.toolId===source.toolId);
      if(decision.form==='SCRIPT'&&generation?.entrypoint)tool.entrypoint={kind:decision.language==='node'?'NODE':'PYTHON',path:generation.entrypoint};
    }
    for(const dependency of inspection.dependencyAnalysis.dependencies)
      dependency.toolIds=dependency.toolIds.map(id=>actualToSource.get(id)??id);
    for(const chain of inspection.dependencyAnalysis.chains)chain.toolId=actualToSource.get(chain.toolId)??chain.toolId;
    const proposal=input.reuseProposal;
    if(proposal){
      if(!proposal.approvedAt||!input.sourceFiles)return conflict('缺少已确认方案及冻结源码，不能审查候选');
      input.onPhase?.('PLAN_REVIEW');
      const output=await this.analysis.reusePlanner({mode:'REVIEW',candidateFiles:decoded,sourceFiles:input.sourceFiles,
        deliveryContract:portableDeliveryContract(input.sourceInspection??input.inspection,input.decisions.filter(d=>d.baseAssetId===input.baseAssetId)),
        sourceInspection:input.sourceInspection??input.inspection,candidateInspection:inspection,design:proposal.design}) as {status?:string;review?:unknown;reason?:string;telemetry?:ReusePlannerTelemetry};
      if(output?.status!=='REVIEWED')return conflict(`候选方案审查未完成：${output?.reason??'缺少审查结果'}`);
      const review=reuseReviewSchema.safeParse(output.review);
      if(!review.success)return conflict('候选审查结果结构不完整');
      const issues=reuseReviewIssues(review.data,proposal.design,decoded);
      if(issues.length)return conflict(`候选未落实已确认迁移方案：${issues.join('；')}`);
      inspection.reuseConformance={proposalId:proposal.proposalId,candidateDigest:input.candidate.artifactSha256,
        reviewedAt:new Date().toISOString(),review:review.data,acceptanceChecks:proposal.design.acceptanceChecks.map(check=>({checkId:check.id,status:'NOT_RUN'})),
        ...(output.telemetry?{telemetry:output.telemetry}:{})};
    }
    return inspection;
  }
}
