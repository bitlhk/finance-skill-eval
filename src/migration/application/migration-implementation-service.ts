import type {SkillAssetRecord} from '../../shared/contracts/skill-asset.js';
import {runtimeToolConfigTemplate,validateAgentRuntimeDelivery} from '../domain/migration-delivery-contract.js';
import {recommendLanguage,type MigrationPlan,type ProjectInspection,type ToolDecision} from '../domain/migration-model.js';
import type {MigrationAgentResultMapper} from './migration-agent-result-mapper.js';
import type {MigrationImplementer} from './migration-agent-port.js';
import {migrationConflict as conflict} from './migration-errors.js';

export class MigrationImplementationService {
  constructor(
    private readonly implementer:MigrationImplementer,
    private readonly agentResults:MigrationAgentResultMapper,
  ) {}

  async generate(archive:Record<string,Uint8Array>,inspection:ProjectInspection,decisions:ToolDecision[],asset:SkillAssetRecord,plan:MigrationPlan){
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

    const attempts=Math.max(1,Number(process.env.FINANCE_EVAL_AGENT_ATTEMPTS??1));
    let agentFailure:string|null=null;
    for(let attempt=1;attempt<=attempts;attempt+=1){
      const result=await this.implementer({
        assetDigest:asset.artifactSha256,runId:asset.assetId,files:archive,
        decisions:decisions.map(decision=>({toolId:decision.toolId,form:decision.form,language:decision.language})),
        tools:inspection.tools.map(tool=>({toolId:tool.toolId,name:tool.name,language:tool.language,sourcePaths:tool.sourcePaths,
          inputSchema:tool.inputSchema,outputSchema:tool.outputSchema,samples:tool.samples,migrationContract:contract[tool.toolId]})),
        contract,
        deliveryContract:{
          skillDocumentation:{sourceSkillFile:asset.skillFile,manifestPathsRelativeToSkillRoot:true},
          script:{execution:'COMMAND',cwd:'WORKSPACE',entrypoint:'RUNTIME_PROVIDED_ABSOLUTE_PATH',packageResources:'RELATIVE_TO_SCRIPT',runtimeInjection:false},
          mcp:{contextTransport:'HTTP_HEADER',serviceConfigurationTransport:'SERVICE_ENV',businessArguments:'SEPARATE',
            pythonFramework:{package:'fastmcp',version:'2.14.7',import:'from fastmcp import FastMCP'}},
          runtimeToolConfigTemplate:runtimeToolConfigTemplate(inspection,decisions),
        },
      });
      if(result?.status==='PRODUCED'||result?.status==='ABSTAINED'){
        const abstained=((result.payload as {tools?:Array<{toolId?:string;status?:string;reason?:string;missing?:string[]}>}).tools??[])
          .filter(item=>String(item.status??'').toUpperCase()==='ABSTAINED');
        if(abstained.length){
          const detail=abstained.map(item=>`${item.toolId||'未知 Tool'}：${item.reason?.trim()||'未说明原因'}${item.missing?.length?`（缺 ${item.missing.join('、')}）`:''}`).join('；');
          return conflict(`有 Tool 无法忠实迁移，已停止生成并退回授权环节重新决策。${detail}`);
        }
        if(result.status==='ABSTAINED')return conflict(`迁移模型无法完成本次迁移，已退回授权环节重新决策。${String((result.payload as {reason?:string}).reason??'').trim()}`);
      }
      if(result?.status==='FAILED'){agentFailure=result.reason;continue}
      if(result?.status==='PRODUCED'){
        const deliveryIssues=validateAgentRuntimeDelivery(result.payload as Record<string,unknown>,inspection,decisions);
        if(deliveryIssues.length){agentFailure=deliveryIssues.join('；');continue}
        const nameById=Object.fromEntries(inspection.tools.map(tool=>[tool.toolId,tool.name]));
        const implementations=this.agentResults.generatedImplementations(result.payload,result.files,nameById);
        const skillDelivery=this.agentResults.skillDocumentDelivery(result.payload,result.files);
        const missing=decisions.filter(decision=>!implementations[decision.toolId]
          ||implementations[decision.toolId]!.language!==plan.items.find(item=>item.toolId===decision.toolId)?.language);
        if(!missing.length&&skillDelivery)return {implementations,skillDelivery};
        if(!skillDelivery){agentFailure='A4 没有按文档清单交付最终 SKILL.md；平台不会在模型完成后替它机械合并或拆分 references';continue}
        agentFailure=`A4 交付不完整或语言与授权不符：${missing.map(decision=>nameById[decision.toolId]??decision.toolId).join('、')}`;
      }
    }
    if(agentFailure)return conflict(`迁移 agent 跑完了但没交付可用结果：${agentFailure}。这是执行问题不是工程问题——不会退回只能产出脚本的回退生成器。请重试或查看 agent 日志。`);
    return conflict('迁移 agent 未返回任何结果。请重试或查看 agent 日志；平台不会切换到另一套代码生成路径。');
  }
}
