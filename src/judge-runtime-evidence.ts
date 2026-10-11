import {workspaceFilesDigest,type RuntimeExecutionEvidence} from './contracts.js';
import {canonicalSha256} from './shared/json-canonicalization.js';

export type JudgeInputEvidence={workspaceFiles?:Array<{path:string;content:string}>;tools?:Array<{name:string;inputSchema?:unknown}>;
 skillPackage?:{artifactSha256:string;files:Record<string,string>}};

function skillFileReads(evidence:RuntimeExecutionEvidence,input:JudgeInputEvidence){
 const skill=input.skillPackage;
 if(!skill||!evidence.runtimeIdentityVerified||evidence.metadata.skillArtifactSha256!==skill.artifactSha256)return [];
 const completed=new Set(evidence.toolCalls.filter(call=>call.status==='completed').map(call=>call.name));
 const facts=Array.isArray(evidence.metadata.toolEvidence)?evidence.metadata.toolEvidence:[];
 return Object.entries(skill.files).flatMap(([path,content])=>{
  if(!path||path.startsWith('/')||path.includes('\\')||path.includes(':')||path.split('/').some(part=>part==='..'||part==='.'||!part))return [];
  // The existing target-skill loader is an explicit file-reading compatibility
  // entrypoint, not a name-only alias. Match its exact target, relative path and
  // full returned content; arbitrary auxiliary tool receipts are not accepted.
  return ['read_file','skill_tool'].flatMap(tool=>{
   const argumentsDigests=tool==='read_file'?[canonicalSha256({path,scope:'skill'})]:[
    canonicalSha256({skill_name:'target-skill',relative_file_path:path}),canonicalSha256({relative_file_path:path})];
   return completed.has(tool)&&facts.some(f=>f&&typeof f==='object'&&f.tool===tool&&f.status==='completed'
    &&argumentsDigests.includes(f.argumentsDigest)&&f.resultDigest===canonicalSha256({path,content}))
    ?[{tool,path,scope:'skill' as const,kind:'FILE_READ' as const}]:[];
  });
 });
}

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

export const skillFileEvidenceGuidance='skillFileReads 仅在 Runtime 身份与已安装 Skill 制品摘要匹配，并且实际 completed 的 read_file(scope=skill) 或既有 skill_tool(target-skill,relative_file_path) 的实参与返回内容摘要均精确匹配已交付文件时生成。记录保留真实工具名，证明加载该相对路径的已交付内容，不暴露正文，不由文件存在或模型自述推断，也不证明 OS 物理读取、程序因果关系或内部内存。无匹配时保持未知，不用 workspaceInputMatches 代替 Skill 包读取事实。';
const supportTools=new Set(['read_file','list_files','skill_tool','list_skill','workspace_info']);
export const runtimeSupportEvidenceGuidance='runtimeSupportToolCalls 也是真实调用证据，可用于核验文件读取、目录发现等明确要求；它们与业务 toolCalls 分开，不应自动算作额外业务操作。辅助调用不提供原始路径、内容或配置。workspaceInputMatches 是平台对实际调用摘要与本案例已挂载文件进行精确核对的事实：FILE_READ 表示工作区读取实参与返回内容均吻合该文件；TOOL_ARGUMENT_VALUES 表示工具实参恰好等于该文件中列出的字段值。不含原始值，不靠摘要反推，不证明程序级因果数据流或 OS 隔离。没有匹配记录时不得推测读取来源或实参。'
 +'sourceFacts 的 result 可以是 JSON 文本，表示实际工具返回内容的获授权脱敏投影，不是模型回答摘要。只有 status=completed 的事实可证明成功结果；failed 的结果只能解释失败。resultDigest 只标识结果，不能反推出金额、名称或时间。resultOmitted 或 sourceFactsCollection 的 DISABLED/PARTIAL 表示对应结果或字段无法核验，不证明工具未调用或缺失字段不存在；CAPTURED 只覆盖已观察的工具结果，不保证全部调用或全部字段。必须核对回答与实际可见结果，不得因 completed 状态就推定数值正确。工具返回的 asOf、数据更新时间或快照时间与宿主 businessDate 是不同概念：除非任务或工具合同明确要求相同，否则不能因两者不同判错，也不能将数据时点改称本次查询执行时间。Skill 要求展示“返回的”信息时，只要求展示工具实际返回且可核验的信息或说明无法获取；不得凭空增加工具未返回的账户类型、名称等字段要求。';

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
    skillFileReads:skillFileReads(evidence,input),
  };
}
