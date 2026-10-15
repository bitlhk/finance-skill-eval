import type {MigrationProject} from './migration-project.js';
import type {ToolInspection} from './migration-model.js';

/** An omitted candidate analysis field cannot erase a preserved source interface.
 * Restore only an exact generated-tool mapping reviewed against this proposal and
 * candidate. Never infer a schema from a sample or replace an explicit new schema.
 */
export function migrationScriptInputSchema(project:MigrationProject,tool:ToolInspection):unknown|undefined{
  if(tool.inputSchema)return tool.inputSchema;
  const generation=project.portableGenerations?.find(item=>item.toolId===tool.toolId&&item.toolName===tool.name&&item.form==='SCRIPT');
  const source=project.sourceInspection?.tools.find(item=>item.toolId===tool.toolId&&item.name===tool.name);
  if(!generation||generation.entrypoint!==tool.entrypoint?.path||!source?.inputSchema)return undefined;
  const proposal=project.reuseProposal,conformance=project.inspection?.reuseConformance;
  if(!proposal?.approvedAt||proposal.sourceDigest!==project.source.artifactSha256
    ||project.inspection?.assetDigest!==project.candidate?.artifactSha256
    ||conformance?.proposalId!==proposal.proposalId||conformance.candidateDigest!==project.candidate?.artifactSha256
    ||conformance.review.unexpectedDependencies.length||conformance.review.semanticIssues.length
    ||conformance.review.changes.length!==proposal.design.changes.length
    ||proposal.design.changes.some(change=>!conformance.review.changes.some(item=>item.changeId===change.id&&item.status==='CONFORMING')))
    throw new Error(`工具 ${tool.name} 缺少已确认的输入合同，请重新审查候选后运行`);
  return structuredClone(source.inputSchema);
}
