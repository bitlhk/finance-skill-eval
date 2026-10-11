import {z} from 'zod';
import {canonicalSha256} from '../../shared/json-canonicalization.js';
import type {RuntimeExecutionEvidence} from '../../contracts.js';
import type {simpleMigrationCaseSchema} from './simple-migration-suite.js';

const identifier=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
/** Explicit, bounded data flow between isolated groups, not shared tool memory. */
export const reuseInputBindingSchema=z.strictObject({
  id:identifier,sourceCaseId:z.string().min(1).max(100),toolName:z.string().min(1).max(200),
  occurrence:z.number().int().min(0).max(255).default(0),
  resultPath:z.array(z.string().min(1).max(100)).min(1).max(8),
});
export type ReuseInputBinding=z.infer<typeof reuseInputBindingSchema>;
export type ReuseInputBindingReceipt={bindingId:string;sourceCaseId:string;sourceJobId:string;sourceTool:string;sourceCallIndex:number;
  resultPath:string[];sourceResultDigest?:string;valueDigest:string;targetCaseId:string;templateDigest:string;queryDigest:string};
type Case=z.infer<typeof simpleMigrationCaseSchema>;
const tokenPattern=/\{\{reuse:([A-Za-z][A-Za-z0-9_-]{0,63})\}\}/g;
const tokens=(value:string)=>[...value.matchAll(tokenPattern)].map(match=>match[1]!);
const forbidden=(key:string)=>/^(?:__proto__|prototype|constructor|token)$/i.test(key)||/(?:password|credential|secret|authorization|api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token)/i.test(key);

export function reuseInputBindingIssues(plan:{groups:Array<{cases:Case[]}>;inputBindings?:ReuseInputBinding[]}){
 const bindings=plan.inputBindings??[],issues:string[]=[],byId=new Map(bindings.map(b=>[b.id,b]));
 if(byId.size!==bindings.length)issues.push('输入绑定标识不能重复');
 for(const binding of bindings){
  if(binding.resultPath.some(forbidden))issues.push(`输入绑定 ${binding.id} 不能读取秘密或对象原型字段`);
  const sourceGroup=plan.groups.findIndex(g=>g.cases.some(c=>c.id===binding.sourceCaseId));
  if(sourceGroup<0)issues.push(`输入绑定 ${binding.id} 的来源案例不存在`);
  let used=false;
  plan.groups.forEach((g,index)=>g.cases.forEach(c=>{
   if([c.input,...(c.turns??[]).map(t=>t.query)].some(q=>tokens(q).includes(binding.id))){
    used=true;if(index<=sourceGroup)issues.push(`输入绑定 ${binding.id} 只能消费前一运行组的真实结果`);
   }
  }));
  if(!used)issues.push(`输入绑定 ${binding.id} 未被执行查询使用`);
 }
 for(const c of plan.groups.flatMap(g=>g.cases)){
  for(const query of [c.input,...(c.turns??[]).map(t=>t.query)]){
   if(query.replace(tokenPattern,'').includes('{{reuse:'))issues.push(`案例 ${c.id} 的输入绑定占位符格式错误`);
   for(const name of tokens(query))if(!byId.has(name))issues.push(`案例 ${c.id} 引用了未定义的输入绑定 ${name}`);
  }
  if(JSON.stringify([c.criteria,c.workspaceFiles??[]]).includes('{{reuse:'))issues.push(`案例 ${c.id} 的输入绑定只能出现在查询中，不修改判据或文件`);
 }
 return [...new Set(issues)];
}

/** Consume only existing authorized tool-result projections; never infer a
 * handle from model prose, a digest, an omitted result or a failed tool call. */
export function resolveReuseInputs(cases:Case[],bindings:ReuseInputBinding[],sources:Map<string,{jobId:string;evidence:RuntimeExecutionEvidence}>){
 const receipts:ReuseInputBindingReceipt[]=[];
 const resolved=cases.map(c=>{
  const replace=(query:string)=>{
   const templateDigest=canonicalSha256(query),used:Array<Omit<ReuseInputBindingReceipt,'queryDigest'>>=[];
   const output=query.replace(tokenPattern,(_token,name:string)=>{
    const binding=bindings.find(b=>b.id===name),source=binding&&sources.get(binding.sourceCaseId);
    if(!binding||!source||!source.evidence.runtimeIdentityVerified||!source.evidence.streamCompleted||source.evidence.status!=='completed')throw new Error(`输入绑定 ${name} 缺少已核验来源结果`);
    const facts=Array.isArray(source.evidence.metadata.toolEvidence)?source.evidence.metadata.toolEvidence:[];
    const calls=facts.flatMap((fact,index)=>{
     const call=source.evidence.toolCalls[index];
     return fact&&typeof fact==='object'&&fact.tool===binding.toolName&&fact.status==='completed'&&call?.name===binding.toolName&&call.status==='completed'?[{fact,index}]:[];
    });
    const selected=calls[binding.occurrence];
    if(!selected||selected.fact.resultOmitted===true||!Object.hasOwn(selected.fact,'result'))throw new Error(`输入绑定 ${name} 没有可用的授权结果投影`);
    let value:unknown=selected.fact.result;
    if(typeof value==='string')try{value=JSON.parse(value)}catch{throw new Error(`输入绑定 ${name} 的结果不是可读取对象`)}
    for(const field of binding.resultPath){
     if(forbidden(field)||!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,field))throw new Error(`输入绑定 ${name} 的结果字段不可用`);
     value=(value as Record<string,unknown>)[field];
    }
    // This primitive transports identifiers, not instructions, bulk data or secrets.
    if(!((typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(value)&&!/^(?:Bearer|sk-)/i.test(value))
      ||typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean'))throw new Error(`输入绑定 ${name} 不是允许传递的短标量`);
    used.push({bindingId:name,sourceCaseId:binding.sourceCaseId,sourceJobId:source.jobId,sourceTool:binding.toolName,sourceCallIndex:selected.index,
     resultPath:binding.resultPath,...(typeof selected.fact.resultDigest==='string'?{sourceResultDigest:selected.fact.resultDigest}:{}),
     valueDigest:canonicalSha256(value),targetCaseId:c.id,templateDigest});
    return typeof value==='string'?value:JSON.stringify(value);
   });
   if(output.length>12000)throw new Error(`案例 ${c.id} 的绑定查询超过长度限制`);
   receipts.push(...used.map(receipt=>({...receipt,queryDigest:canonicalSha256(output)})));return output;
  };
  return {...c,input:replace(c.input),...(c.turns?{turns:c.turns.map(t=>({...t,query:replace(t.query)}))}:{})};
 });
 return {cases:resolved,receipts};
}
