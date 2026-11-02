import type {RuntimeExecutionEvidence} from '../../contracts.js';

export type EvidenceCheck={id:string;status:'PASS'|'FAIL'|'UNVERIFIED';reason:string};

/** These checks verify execution evidence, never business quality or candidate adoption. */
export function checkExecutionEvidence(evidence:RuntimeExecutionEvidence,expected?:{
  contentDigest:string;members:ReadonlyArray<{skillId:string;version:string}>;
}):EvidenceCheck[]{
  const checks:EvidenceCheck[]=[
    {id:'execution.completed',status:evidence.status==='completed'?'PASS':'FAIL',reason:evidence.status},
    {id:'execution.stream',status:evidence.streamCompleted?'PASS':'UNVERIFIED',reason:'执行流完整性'},
    {id:'execution.identity',status:evidence.runtimeIdentityVerified?'PASS':'UNVERIFIED',reason:'运行身份核验'},
  ];
  if(expected){
    checks.push({id:'execution.artifact',status:evidence.metadata.contentDigest===expected.contentDigest?'PASS':'UNVERIFIED',reason:'候选摘要核验'});
    for(const member of expected.members)checks.push({id:`execution.skill:${member.skillId}@${member.version}`,
      status:evidence.loadedSkills.some(s=>s.skillId===member.skillId&&s.version===member.version)?'PASS':'UNVERIFIED',reason:'Skill 组装载核验'});
  }
  return checks;
}
