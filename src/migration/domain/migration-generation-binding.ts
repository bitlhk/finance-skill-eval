import {canonicalSha256} from '../../shared/json-canonicalization.js';
import type {MigrationProject} from './migration-project.js';
import {currentReuseProposal} from './migration-reuse-design.js';
import {portableDeliveryContract} from './migration-delivery-contract.js';
import {reuseExecutionContract} from './migration-reuse-execution-contract.js';

/** The same verified source, chosen tool forms, approved design and executable contracts on every stage. */
export function generationInputDigest(project:MigrationProject,materialsDigest:string){
  const base=project.candidate??project.source,sourceInspection=project.sourceInspection??project.inspection;
  const decisions=(project.decisions??[]).filter(item=>item.baseAssetId===base.assetId)
    .map(({toolId,form,language})=>({toolId,form,language})).sort((a,b)=>a.toolId.localeCompare(b.toolId));
  const proposal=currentReuseProposal(project);
  const facts=sourceInspection&&(({inspectedAt:_,reuseConformance:__,...facts})=>facts)(sourceInspection);
  return canonicalSha256(JSON.parse(JSON.stringify({revision:'generation-checkpoints-1',base,
    source:project.source,facts,decisions,materialsDigest,
    proposal:proposal&&{proposalId:proposal.proposalId,inputDigest:proposal.inputDigest,design:proposal.design},
    deliveryContract:sourceInspection&&portableDeliveryContract(sourceInspection,(project.decisions??[]).filter(d=>d.baseAssetId===base.assetId),project.source.skillFile),
    executionContract:reuseExecutionContract})));
}
