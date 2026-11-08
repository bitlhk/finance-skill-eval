import type {BundleTask} from "../../../../contracts/platform/responses";
import type {MigrationApi} from './useMigrationTask';
import {MIGRATION_CASE_LIMIT} from './form-limits';

export type CaseProposal={name:string;coverage:string;cases:Array<{input:string;criteria:string[];rationale?:string}>};

export function caseProposal(value:unknown):CaseProposal|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const item=value as Record<string,unknown>;
  if(typeof item.name!=='string'||!item.name.trim()||typeof item.coverage!=='string'||!item.coverage.trim()
    ||!Array.isArray(item.cases)||!item.cases.length||item.cases.length>8)return null;
  const cases:CaseProposal['cases']=[];
  for(const raw of item.cases){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
    const c=raw as Record<string,unknown>;
    if(typeof c.input!=='string'||!c.input.trim()||c.input.length>12000||!Array.isArray(c.criteria)||!c.criteria.length||c.criteria.length>20
      ||c.criteria.some(value=>typeof value!=='string'||!value.trim()||value.length>2000)
      ||(c.rationale!==undefined&&(typeof c.rationale!=='string'||c.rationale.length>2000)))return null;
    cases.push({input:c.input,criteria:c.criteria as string[],...(typeof c.rationale==='string'?{rationale:c.rationale}:{})});
  }
  return {name:item.name,coverage:item.coverage,cases};
}

/** Append to the unsaved editor; never change holdout cases or silently replace user data. */
export function addProposalToDraft(value:string,proposal:CaseProposal,makeId:()=>string=()=>crypto.randomUUID()):string{
  let suite:Record<string,unknown>;
  try{suite=JSON.parse(value);}catch{throw new Error('测试集草稿格式不正确，请先在高级设置中修正。');}
  if(!suite||typeof suite!=='object'||Array.isArray(suite)||typeof suite.name!=='string'||!Array.isArray(suite.cases))
    throw new Error('测试集草稿格式不正确，请先在高级设置中修正。');
  const prior=suite.cases as Array<Record<string,unknown>>;
  const blank=prior.length===1&&prior[0]&&typeof prior[0].input==='string'&&!prior[0].input.trim()
    &&Array.isArray(prior[0].criteria)&&prior[0].criteria.every(value=>typeof value==='string'&&!value.trim())
    &&Object.keys(prior[0]).every(key=>['id','input','criteria'].includes(key));
  const existing=blank?[]:prior;
  if(existing.length+proposal.cases.length>MIGRATION_CASE_LIMIT)throw new Error(`开发测试集最多 ${MIGRATION_CASE_LIMIT} 个案例，请先删减后再加入。`);
  // The same request can represent different scenarios when its expected
  // behavior, workspace or business state differs. Only reject a matching
  // request and criteria when no explicit fixture distinguishes the case.
  const fingerprint=(input:string,criteria:string[],rationale?:string)=>JSON.stringify([input.trim(),criteria.map(value=>value.trim()),rationale?.trim()??'']);
  const duplicates=new Set(existing.flatMap(item=>typeof item?.input==='string'&&Array.isArray(item.criteria)
    &&item.criteria.every(value=>typeof value==='string')&&!item.stateFixture&&!item.workspaceFiles&&!item.turns
    ?[fingerprint(item.input,item.criteria as string[],typeof item.rationale==='string'?item.rationale:undefined)]:[]));
  for(const item of proposal.cases){const key=fingerprint(item.input,item.criteria,item.rationale);
    if(duplicates.has(key))throw new Error('已有任务内容、判断标准和设计说明均相同的案例，请先核对或编辑现有案例。');
    duplicates.add(key);}
  const cases=proposal.cases.map(item=>({id:makeId(),input:item.input,criteria:item.criteria,...(item.rationale?.trim()?{rationale:item.rationale.trim()}:{})}));
  return JSON.stringify({...suite,cases:[...existing,...cases]},null,2);
}

export async function requestCaseDesign(api:MigrationApi,taskId:string,key:string,draft?:string):Promise<BundleTask|undefined>{
  let existing:Array<{input:string;criteria:string[];rationale?:string}> = [];
  try{
    const parsed=JSON.parse(draft??'null');
    if(Array.isArray(parsed?.cases))existing=parsed.cases.slice(0,MIGRATION_CASE_LIMIT).flatMap((item:unknown)=>{
      if(!item||typeof item!=='object'||Array.isArray(item))return [];
      const value=item as Record<string,unknown>;
      return typeof value.input==='string'&&value.input.trim()?[{input:value.input.slice(0,200),
        criteria:Array.isArray(value.criteria)?value.criteria.filter((entry):entry is string=>typeof entry==='string').slice(0,2).map(entry=>entry.slice(0,100)):[],
        ...(typeof value.rationale==='string'&&value.rationale.trim()?{rationale:value.rationale.slice(0,150)}:{})}]:[];
    });
  }catch{/* An invalid editor draft is not forwarded. */}
  // The conversation API limits the whole message to 16,000 characters.
  // Escaping control characters can expand JSON well beyond the raw slices.
  const summarized:typeof existing=[];
  for(const item of existing){
    if(JSON.stringify([...summarized,item]).length>14000)break;
    summarized.push(item);
  }
  const response=await api<{task?:BundleTask}>(`/api/migration-tasks/${encodeURIComponent(taskId)}/conversation/message`,{
    method:'POST',body:JSON.stringify({key,text:'请结合任务目标、现有 Skill、工具与工程，先分析实际业务场景、关键步骤和风险，再选择适用的场景设计供我审阅的开发测试案例。说明覆盖原因、判断所需证据和尚缺的数据；根据需要分批提出，不必机械覆盖不适用的场景。不要编造业务事实、标准答案或修改现有测试集。'
      +(summarized.length?'\n已有开发案例摘要（用于去重和覆盖分析，可能截断）：'+JSON.stringify(summarized):'')
      +(summarized.length<existing.length?'\n部分案例摘要因长度限制未提供，请勿假定已经覆盖整个开发集。':'')})});
  return response.task;
}
