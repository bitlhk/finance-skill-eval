import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Diagnosis } from './migration-diagnostics.js';
import { stableToolId,type ProjectInspection,type ToolInspection } from './migration-model.js';
import { validateSkill } from './skill-validator.js';

const languageOf=(name:string)=>name.endsWith('.py')?'Python':name.endsWith('.java')?'Java':/[.](?:js|mjs|cjs|ts)$/u.test(name)?'JavaScript':name.endsWith('.go')?'Go':name.endsWith('.rs')?'Rust':null;
const lineOf=(source:string,index:number)=>source.slice(0,index).split(/\r?\n/u).length;
const codeOnly=(source:string)=>source
  .replace(/\/\*[\s\S]*?\*\//gu,' ')
  .replace(/(^|[^:])\/\/.*$/gmu,'$1 ')
  .replace(/#.*$/gmu,' ')
  .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/gu,' ');

function mentions(source:string,name:string){return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')}\\b`,'u').test(source);}
function declaredObject(source:string,label:RegExp){
  const match=label.exec(source);if(!match)return null;
  const start=source.indexOf('{',match.index+match[0].length);if(start<0)return null;
  let depth=0,quote='',escaped=false;
  for(let index=start;index<source.length;index++){
    const char=source[index]!;
    if(quote){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char===quote)quote='';continue;}
    if(char==='"'||char==="'"){quote=char;continue;}
    if(char==='{')depth++;else if(char==='}'&&--depth===0){const raw=source.slice(start,index+1);try{return JSON.parse(raw);}catch{try{return parseYaml(raw);}catch{return null;}}}
  }
  return null;
}

export function inspectProject(input:{assetId:string;assetDigest:string;files:Record<string,string>;skillFile:string;diagnosis?:Diagnosis|null}):ProjectInspection{
  const skill=validateSkill(input.files,input.skillFile),method=input.files[input.skillFile]??'';
  const names=new Set<string>();
  // A backticked word in prose is a hint, not a Tool. Harvesting every one of them
  // turned ordinary prose into phantom Tools; only a name that also appears as an
  // identifier in code becomes a candidate.
  const codeCorpus=Object.entries(input.files)
    .filter(([name])=>/\.(?:py|java|js|mjs|cjs|ts|tsx|go|rb|cs|kt)$/iu.test(name))
    .map(([,content])=>content).join('\n');
  const appearsInCode=(name:string)=>new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')}([^A-Za-z0-9_]|$)`,'mu').test(codeCorpus);
  for(const hit of method.matchAll(/`([a-zA-Z_][a-zA-Z0-9_-]*)`/gu))if(appearsInCode(hit[1]!))names.add(hit[1]!);
  for(const declaration of input.diagnosis?.declarations??[]){
    const source=input.files[declaration.path]??'';
    if(!['register','main','invoke','run'].includes(declaration.name)&&/register_tool|registerTool|@tool|@Tool|FastMCP|McpServer/iu.test(source))names.add(declaration.name);
  }
  for(const [file,source] of Object.entries(input.files)){
    if(!/(?:^|\/)scripts\/[^/]+\.(?:py|js|mjs|cjs)$/iu.test(file))continue;
    if(/__main__|process\.argv|argparse|sys\.stdin|JSON\.parse/iu.test(source))names.add(path.posix.basename(file).replace(/\.[^.]+$/u,'').replace(/-/gu,'_'));
  }
  for(const finding of input.diagnosis?.findings??[])if(finding.source==='MODEL'&&finding.symbol)names.add(finding.symbol);
  const tools:ToolInspection[]=[...names].sort().map(name=>inspectTool(name,input.files,input.skillFile,input.diagnosis));
  const incompleteFiles=input.diagnosis?[...input.diagnosis.coverage
    .filter(item=>!['AST_PARSED','TEXT_INSPECTED'].includes(item.status))
    .map(item=>({path:item.path,status:item.status})),
    ...input.diagnosis.findings.filter(item=>item.layer==='UNKNOWN').map(item=>({path:item.path,status:item.dependencyType}))
  ].filter((item,index,all)=>all.findIndex(other=>other.path===item.path&&other.status===item.status)===index):[];
  const toolPaths=new Set(tools.flatMap(tool=>tool.sourcePaths));
  return {assetId:input.assetId,assetDigest:input.assetDigest,inspectedAt:new Date().toISOString(),skill,tools,scriptsExecuted:false,
    staticAnalysis:input.diagnosis?{status:input.diagnosis.status,dependencyStatus:input.diagnosis.dependencyStatus,
      scannerDigest:input.diagnosis.scannerDigest,incompleteFiles,toolIncompleteFiles:incompleteFiles.filter(item=>toolPaths.has(item.path))}
      :{status:'UNAVAILABLE',dependencyStatus:'UNKNOWN',scannerDigest:null,incompleteFiles:[],toolIncompleteFiles:[]},
    runtimeAnalysis:input.diagnosis?{status:input.diagnosis.ai.status,model:input.diagnosis.ai.model,
      acceptedBindings:input.diagnosis.ai.acceptedRuntimeBindings??0,rejectedBindings:input.diagnosis.ai.rejectedRuntimeBindings??0,
      inputTruncated:input.diagnosis.ai.inputTruncated}:undefined};
}

function inspectTool(name:string,files:Record<string,string>,skillFile:string,diagnosis?:Diagnosis|null):ToolInspection{
  const modelPaths=new Set((diagnosis?.findings??[]).filter(f=>f.source==='MODEL'&&f.symbol===name).map(f=>f.path));
  const matched=Object.entries(files).filter(([file,source])=>file!==skillFile&&(mentions(codeOnly(source),name)||modelPaths.has(file)));
  const sourcePaths=matched.map(([file])=>file);
  const evidence:ToolInspection['evidence']=[],findings:ToolInspection['findings']=[];
  let mcp=false,runtime=false,script=false,hasSchema=false,inputSchema:unknown=null,outputSchema:unknown=null,entrypoint:ToolInspection['entrypoint'];
  for(const [file,source] of matched){
    const code=codeOnly(source),at=code.search(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')}\\b`,'u'));
    const mcpImport=/(?:^|\n)\s*(?:import|from|require\s*\()[^\n]*(?:@modelcontextprotocol|modelcontextprotocol)/iu.test(source);
    if(mcpImport||/FastMCP|McpServer|CallToolResult|ServerCapabilities/iu.test(code)){
      mcp=true;evidence.push({path:file,line:lineOf(source,Math.max(0,at)),kind:'MCP_DECLARATION',detail:'发现 MCP Server 或 Tool 声明'});
    }
    if(/inputSchema|input_schema|jsonSchema|JsonSchema|schema\s*[:=]/iu.test(code)){
      hasSchema=true;evidence.push({path:file,line:lineOf(source,code.search(/inputSchema|input_schema|jsonSchema|JsonSchema|schema\s*[:=]/iu)),kind:'SCHEMA_DECLARATION',detail:'发现静态 Schema 声明'});
      inputSchema??=declaredObject(source,/(?:inputSchema|input_schema|jsonSchema|JsonSchema|schema)\s*[:=]\s*/iu);
    }
    outputSchema??=declaredObject(source,/(?:outputSchema|output_schema)\s*[:=]\s*/iu);
    const runtimeImport=/(?:^|\n)\s*(?:import|from|require\s*\()[^\n]*(?:agentscope|langchain|langgraph|openjiuwen)/iu.test(source);
    if((runtimeImport||/agentscope|langchain|langgraph|openjiuwen/iu.test(code))&&/register_tool|registerTool|toolkit\.|ToolResponse|Session|Context/iu.test(code)){
      runtime=true;evidence.push({path:file,line:lineOf(source,Math.max(0,at)),kind:'RUNTIME_BINDING',detail:'发现 Agent Runtime SDK 注册、结果或上下文依赖'});
    }
    if(/(?:^|\/)scripts\/[^/]+\.(?:py|js|mjs|cjs)$/iu.test(file)&&/__main__|process\.argv|argparse|sys\.stdin|JSON\.parse/iu.test(code)){
      script=true;entrypoint={kind:file.endsWith('.py')?'PYTHON':'NODE',path:file};
      evidence.push({path:file,line:1,kind:'SCRIPT_ENTRYPOINT',detail:'发现可独立启动的命令行入口'});
    }
  }
  const related=(diagnosis?.findings??[]).filter(f=>sourcePaths.includes(f.path)&&(f.symbol===name||!f.symbol));
  const runtimeFinding=related.find(f=>['SDK_IMPORT','SDK_INPUT','SDK_RESULT','TOOL_REGISTRATION','RUNTIME_CONTEXT','RUNTIME_STATE','RESOURCE_INJECTION','DYNAMIC_RUNTIME_BINDING'].includes(f.dependencyType));
  if(runtimeFinding&&!runtime){
    runtime=true;evidence.push({path:runtimeFinding.path,line:runtimeFinding.line,kind:'RUNTIME_BINDING',detail:runtimeFinding.source==='MODEL'?'模型发现并经源码定位校验的 Runtime SDK 耦合':'静态分析发现 Runtime SDK 耦合'});
  }
  if(related.some(f=>['MISSING_MODULE','OMITTED_IMPLEMENTATION','DYNAMIC_DEPENDENCY'].includes(f.dependencyType)))
    findings.push({code:'IMPLEMENTATION_INCOMPLETE',severity:'ERROR',path:related[0]!.path,line:related[0]!.line,message:'业务实现或依赖不完整。'});
  let portability:ToolInspection['portability'],kind:ToolInspection['kind'],recommendedAction:ToolInspection['recommendedAction'];
  if(findings.some(f=>f.severity==='ERROR')){portability='INCOMPLETE';kind=mcp?'MCP':runtime?'RUNTIME_BOUND':script?'SCRIPT':'UNKNOWN';recommendedAction=mcp||languageOf(sourcePaths[0]??'')==='Java'?'MIGRATE_TO_MCP':'MIGRATE_TO_SCRIPT';}
  else if(mcp&&hasSchema){portability='PORTABLE_MCP';kind='MCP';recommendedAction='MIGRATE_TO_MCP';}
  else if(script){portability='PORTABLE_SCRIPT';kind='SCRIPT';recommendedAction='MIGRATE_TO_SCRIPT';}
  else if(runtime){portability='RUNTIME_BOUND';kind='RUNTIME_BOUND';recommendedAction=languageOf(sourcePaths[0]??'')==='Java'?'MIGRATE_TO_MCP':'MIGRATE_TO_SCRIPT';}
  else if(mcp){portability='INCOMPLETE';kind='MCP';recommendedAction='MIGRATE_TO_MCP';findings.push({code:'SCHEMA_MISSING',severity:'ERROR',path:sourcePaths[0]??skillFile,line:1,message:'MCP Tool 缺少可确认的输入 Schema。'});}
  else {portability='INCOMPLETE';kind='UNKNOWN';recommendedAction='MIGRATE_TO_SCRIPT';findings.push({code:'IMPLEMENTATION_NOT_FOUND',severity:'ERROR',path:skillFile,line:1,message:'Skill 引用了 Tool，但没有找到可确认的实现。'});}
  const language=[...new Set(sourcePaths.map(languageOf).filter(v=>v!==null))].join(', ')||null;
  if(mcp&&hasSchema&&inputSchema===null)findings.push({code:'SCHEMA_NOT_STATICALLY_RESOLVED',severity:'WARNING',path:sourcePaths[0]??skillFile,line:1,message:'发现 Schema 声明，但静态检查无法还原其完整内容；技术验证将以 MCP tools/list 为准。'});
  return {toolId:stableToolId(name,sourcePaths),name,sourcePaths,language,kind,portability,inputSchema,outputSchema,evidence,findings,recommendedAction,...(entrypoint?{entrypoint}:{})};
}
