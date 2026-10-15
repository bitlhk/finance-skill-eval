/** Evidence gates only: this is not production authorization or professional sign-off. */
export function migrationDeliveryStatus(input:{targetExecution:string;reuseDesign:string;reuseAcceptance:string;technicalReady:boolean}){
  const gaps:string[]=[];
  if(!input.technicalReady)gaps.push('工具或运行依赖尚未验证完成');
  if(input.reuseDesign!=='REVIEWED')gaps.push('当前候选尚未通过迁移方案落实审查');
  if(input.targetExecution!=='PASSED')gaps.push('当前候选尚未通过业务评测');
  if(input.reuseAcceptance!=='PASSED')gaps.push(input.reuseAcceptance==='STALE'?'复用验收结果已失效':'当前候选尚未通过完整复用验收');
  return {status:gaps.length?'UNVERIFIED' as const:'VERIFIED' as const,gaps};
}
