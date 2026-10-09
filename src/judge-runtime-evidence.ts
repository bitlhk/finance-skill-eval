import {workspaceFilesDigest,type RuntimeExecutionEvidence} from './contracts.js';
import {canonicalSha256} from './shared/json-canonicalization.js';

export type JudgeInputEvidence={workspaceFiles?:Array<{path:string;content:string}>;tools?:Array<{name:string;inputSchema?:unknown}>};

/** Compare hashes against already-authorized case inputs, never reverse hashes or
 * forward file/argument values. This proves value equality, not causal data flow. */
function workspaceInputMatches(evidence:RuntimeExecutionEvidence,input:JudgeInputEvidence){
 const files=input.workspaceFiles??[],facts=Array.isArray(evidence.metadata.toolEvidence)?evidence.metadata.toolEvidence:[];
 if(!files.length||evidence.metadata.workspaceFilesMounted!==true||evidence.metadata.workspaceFilesDigest!==workspaceFilesDigest(files))return [];
 const completed=new Set(evidence.toolCalls.filter(call=>call.status==='completed').map(call=>call.name));
 const matches:Array<{tool:string;path:string;kind:'FILE_READ'|'TOOL_ARGUMENT_VALUES';fields?:string[]}>=[];
 for(const file of files){
  const read=facts.some(f=>f&&typeof f==='object'&&f.tool==='read_file'&&f.status==='completed'&&completed.has('read_file')
   &&[canonicalSha256({path:file.path}),canonicalSha256({path:file.path,scope:'workspace'})].includes(f.argumentsDigest)
   &&f.resultDigest===canonicalSha256({path:file.path,content:file.content}));
  if(!read)continue;
  matches.push({tool:'read_file',path:file.path,kind:'FILE_READ'});
  let values;try{values=JSON.parse(file.content)}catch{continue}
  if(!values||typeof values!=='object'||Array.isArray(values))continue;
  for(const tool of input.tools??[]){
   const schema=tool.inputSchema as {type?:string;properties?:Record<string,unknown>}|undefined;
   if(schema?.type!=='object'||!schema.properties||typeof schema.properties!=='object')continue;
   const fields=Object.keys(schema.properties).filter(key=>Object.hasOwn(values,key));
   if(!fields.length)continue;
   const expected=canonicalSha256(Object.fromEntries(fields.map(key=>[key,values[key]])));
   if(completed.has(tool.name)&&facts.some(f=>f&&typeof f==='object'&&f.tool===tool.name&&f.status==='completed'&&f.argumentsDigest===expected))
    matches.push({tool:tool.name,path:file.path,kind:'TOOL_ARGUMENT_VALUES',fields});
  }
 }
 return matches;
}

const supportTools=new Set(['read_file','list_files','skill_tool','list_skill','workspace_info']);
export const runtimeSupportEvidenceGuidance='runtimeSupportToolCalls 也是真实调用证据，可用于核验文件读取、目录发现等明确要求；它们与业务 toolCalls 分开，不应自动算作额外业务操作。辅助调用不提供原始路径、内容或配置。workspaceInputMatches 是平台对实际调用摘要与本案例已挂载文件进行精确核对的事实：FILE_READ 表示工作区读取实参与返回内容均吻合该文件；TOOL_ARGUMENT_VALUES 表示工具实参恰好等于该文件中列出的字段值。不含原始值，不靠摘要反推，不证明程序级因果数据流或 OS 隔离。没有匹配记录时不得推测读取来源或实参。';

/** Retain proof of native capability use without disclosing workspace contents. */
export function judgeRuntimeEvidence(evidence:RuntimeExecutionEvidence,input:JudgeInputEvidence={}){
  const conversation=evidence.metadata.conversation as {turns?:Array<{index:number;status:string;queryDigest:string;outputDigest:string;output:string;toolNames:string[]}>}|undefined;
  return {
    status:evidence.status,
    streamCompleted:evidence.streamCompleted,
    toolCalls:evidence.toolCalls.filter(call=>!supportTools.has(call.name)),
    runtimeSupportToolCalls:evidence.toolCalls.filter(call=>supportTools.has(call.name)).map(({name,status})=>({name,status})),
    sourceFacts:Array.isArray(evidence.metadata.toolEvidence)
      ?evidence.metadata.toolEvidence.filter((item:unknown)=>item&&typeof item==='object'&&'tool' in item&&typeof item.tool==='string'&&!supportTools.has(item.tool)):[],
    ...(conversation&&Array.isArray(conversation.turns)?{conversation:{turns:conversation.turns.map(({index,status,queryDigest,outputDigest,output,toolNames})=>({index,status,queryDigest,outputDigest,output,toolNames}))}}:{}),
    ...(evidence.metadata.workspaceFilesMounted===true?{workspaceFilesMounted:true,workspaceFilesDigest:evidence.metadata.workspaceFilesDigest}:{}),
    workspaceInputMatches:workspaceInputMatches(evidence,input),
  };
}
