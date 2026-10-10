import type {SkillAssetRecord} from '../../shared/contracts/skill-asset.js';
import {parse as parseYaml} from 'yaml';
import {agentDocumentDeliveryIssues,portableDeliveryContract,validateAgentRuntimeDelivery} from '../domain/migration-delivery-contract.js';
import {recommendLanguage,type MigrationPlan,type ProjectInspection,type ToolDecision} from '../domain/migration-model.js';
import type {MigrationAgentResultMapper} from './migration-agent-result-mapper.js';
import type {MigrationImplementer} from './migration-agent-port.js';
import {migrationConflict as conflict} from './migration-errors.js';
import {MigrationGenerationError} from '../domain/migration-generation-progress.js';

export function validSkillFrontmatter(source:string|undefined):boolean{
  const match=source?.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u);
  if(!match)return false;
  try{
    const metadata=parseYaml(match[1]!);
    return !!metadata&&typeof metadata==='object'&&!Array.isArray(metadata)
      &&typeof metadata.name==='string'&&metadata.name.trim().length>0
      &&typeof metadata.description==='string'&&metadata.description.trim().length>0;
  }catch{return false;}
}

export class MigrationImplementationService {
  constructor(
    private readonly implementer:MigrationImplementer,
    private readonly agentResults:MigrationAgentResultMapper,
  ) {}

  async generate(archive:Record<string,Uint8Array>,inspection:ProjectInspection,decisions:ToolDecision[],asset:SkillAssetRecord,plan:MigrationPlan){
    // An approved design can require document work even without business tools.
    if(!inspection.tools.length&&!decisions.length&&!plan.reuseProposal)return {implementations:{},
      generationStats:{agentAttempts:0,outputCorrectionAttempts:0}};
    const contract:Record<string,unknown>={};
    for(const decision of decisions){
      const tool=inspection.tools.find(item=>item.toolId===decision.toolId);
      const language=plan.items.find(item=>item.toolId===decision.toolId)?.language??recommendLanguage(decision.form,tool?.language??null);
      const sample=this.agentResults.contractSample(tool);
      contract[decision.toolId]={
        form:decision.form,language,toolName:tool?.name??'',
        dependencies:inspection.dependencyAnalysis?.dependencies.filter(dependency=>dependency.toolIds.includes(decision.toolId))??[],
        runtimeInjection:'SERVICE_ENV dependencies are startup configuration: read the declared environment variable inside the MCP service, never from request Headers or business arguments. Actual values are supplied by the launcher, never sent to this model. runtimeToolConfig is for MCP only: contextBindings map HTTP Header names to context references, auth providers return request headers, and business arguments remain separate. Script runs through generic command with no additional Runtime injection. Never ask the model to supply injected fields.',
        inputSchema:tool?.inputSchema??null,outputSchema:tool?.outputSchema??null,samples:(tool?.samples??[]).map(item=>item.input),
        ...('reason' in sample?{sampleMissing:sample.reason}:{sampleInput:sample.input}),
      };
    }

    const configuredAttempts=Number(process.env.FINANCE_EVAL_AGENT_ATTEMPTS??2);
    const attempts=Number.isSafeInteger(configuredAttempts)&&configuredAttempts>0?configuredAttempts:2;
    let agentFailure:string|null=null;
    for(let attempt=1;attempt<=attempts;attempt+=1){
      const result=await this.implementer({
        assetDigest:asset.artifactSha256,runId:asset.assetId,files:archive,
        decisions:decisions.map(decision=>({toolId:decision.toolId,form:decision.form,language:decision.language})),
        tools:inspection.tools.map(tool=>({toolId:tool.toolId,name:tool.name,language:tool.language,sourcePaths:tool.sourcePaths,
          inputSchema:tool.inputSchema,outputSchema:tool.outputSchema,samples:tool.samples,migrationContract:contract[tool.toolId]})),
        contract,
        deliveryContract:{
          ...portableDeliveryContract(inspection,decisions,asset.skillFile),
          approvedReuseProposal:plan.reuseProposal,
          ...(agentFailure?{retryFeedback:agentFailure}:{}),
        },
      });
      if(result?.status==='PRODUCED'||result?.status==='ABSTAINED'){
        const abstained=((result.payload as {tools?:Array<{toolId?:string;status?:string;reason?:string;missing?:string[]}>}).tools??[])
          .filter(item=>String(item.status??'').toUpperCase()==='ABSTAINED');
        if(abstained.length){
          const detail=abstained.map(item=>`${item.toolId||'未知 Tool'}：${item.reason?.trim()||'未说明原因'}${item.missing?.length?`（缺 ${item.missing.join('、')}）`:''}`).join('；');
          throw new MigrationGenerationError({phase:'GENERATING',code:'IMPLEMENTATION_ABSTAINED',
            message:`有 Tool 无法忠实迁移，已停止生成并退回授权环节重新决策。${detail}`,recoverable:false});
        }
        if(result.status==='ABSTAINED')throw new MigrationGenerationError({phase:'GENERATING',code:'IMPLEMENTATION_ABSTAINED',
          message:`迁移模型无法完成本次迁移，已退回授权环节重新决策。${String((result.payload as {reason?:string}).reason??'').trim()}`,recoverable:false});
      }
      if(result?.status==='FAILED'){
        if(result.failureKind==='OUTPUT_FORMAT')return conflict(`A4 的模型输出经过格式纠错仍无法解析：${result.reason}。请查看 agent 日志；不重复执行代码生成与工具测试。`);
        agentFailure=result.reason;continue;
      }
      if(result?.status==='PRODUCED'){
        const deliveryIssues=validateAgentRuntimeDelivery(result.payload as Record<string,unknown>,inspection,decisions);
        if(deliveryIssues.length){agentFailure=deliveryIssues.join('；');continue}
        const nameById=Object.fromEntries(inspection.tools.map(tool=>[tool.toolId,tool.name]));
        const implementations=this.agentResults.generatedImplementations(result.payload,result.files,nameById);
        const skillDelivery=this.agentResults.skillDocumentDelivery(result.payload,result.files);
        if(skillDelivery&&!validSkillFrontmatter(skillDelivery.files['SKILL.md'])){
          agentFailure='最终 SKILL.md 的 YAML frontmatter 无法解析，或缺少字符串 name/description；请修正并重新交付';
          continue;
        }
        const missing=decisions.filter(decision=>!implementations[decision.toolId]
          ||implementations[decision.toolId]!.language!==plan.items.find(item=>item.toolId===decision.toolId)?.language);
        if(!missing.length&&skillDelivery)return {implementations,skillDelivery,
          generationStats:{agentAttempts:attempt,outputCorrectionAttempts:result.outputCorrectionAttempts??0}};
        if(!skillDelivery){agentFailure=agentDocumentDeliveryIssues(result.payload as Record<string,unknown>,result.files).join('；')||'文档内容不是合法的 UTF-8/base64，或 SKILL.md 为空；请修正实际文件并重新交付';continue}
        agentFailure=`A4 交付不完整或语言与授权不符：${missing.map(decision=>nameById[decision.toolId]??decision.toolId).join('、')}`;
      }
    }
    if(agentFailure)return conflict(`迁移 agent 跑完了但没交付可用结果：${agentFailure}。这是执行问题不是工程问题——不会退回只能产出脚本的回退生成器。请重试或查看 agent 日志。`);
    return conflict('迁移 agent 未返回任何结果。请重试或查看 agent 日志；平台不会切换到另一套代码生成路径。');
  }
}
