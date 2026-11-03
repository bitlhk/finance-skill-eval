import {z} from 'zod';
import type {RuntimeExecutionRequest} from '../../adapters.js';
import {caseStateFixtureSchema,caseStateReceiptSchema} from '../../shared/contracts/case-state.js';
import {canonicalSha256} from '../../shared/json-canonicalization.js';

const schema=z.object({version:z.literal('1'),operationId:z.string().uuid(),fixture:caseStateFixtureSchema,
  status:z.enum(['COMPLETE','INCOMPLETE']),receipts:z.array(caseStateReceiptSchema).max(3),errors:z.array(z.object({phase:z.string(),message:z.string()})).max(3)});
export function validateCaseState(value:unknown,request:RuntimeExecutionRequest,sourceSide=request.side){
  const parsed=schema.safeParse(value);
  const invalid=(reason:string)=>({status:'INCOMPLETE',reason,...(parsed.success?{reported:parsed.data}:{})});
  if(!parsed.success)return invalid('缺少有效的业务状态回执');
  const record=parsed.data,fixture=request.evalCase.stateFixture!;
  if(record.status!=='COMPLETE'||record.errors.length||canonicalSha256(record.fixture)!==canonicalSha256(fixture))return invalid('状态操作未完整成功或测试初态不一致');
  for(const phase of ['prepare','capture','restore'] as const){
    const receipts=record.receipts.filter(r=>r.phase===phase),receipt=receipts[0];
    if(receipts.length!==1||!receipt||receipt.status!=='SUCCEEDED'||receipt.operationId!==record.operationId||receipt.runId!==request.runId
      ||receipt.caseId!==request.evalCase.caseId||receipt.side!==sourceSide||canonicalSha256(receipt.fixture)!==canonicalSha256(fixture))return invalid('业务状态回执与本次案例不匹配');
    if(!receipt.stateDigest||(phase!=='capture'&&receipt.stateDigest!==fixture.initialStateDigest)
      ||(phase==='capture'&&receipt.state===undefined)
      ||(receipt.state!==undefined&&canonicalSha256(receipt.state)!==receipt.stateDigest))return invalid('业务初末状态或恢复摘要不一致');
  }
  return record;
}
