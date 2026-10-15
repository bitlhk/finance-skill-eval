import type {ProjectInspection,ToolDecision} from './migration-model.js';

export type RetiredSource={path:string;reason:string};

/** An explicit model decision, not a filename heuristic or a change to the uploaded asset. */
export function parseRetiredSources(value:unknown):RetiredSource[]|null{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>100)return null;
 const result:RetiredSource[]=[],seen=new Set<string>();
 for(const item of value){
  if(!item||typeof item!=='object'||Array.isArray(item))return null;
  const entry=item as Record<string,unknown>;
  if(Object.keys(entry).some(key=>key!=='path'&&key!=='reason')||typeof entry.path!=='string'||typeof entry.reason!=='string')return null;
  const path=entry.path.replaceAll('\\','/').replace(/^\.\//u,'');
  if(!path||path.length>1000||path.startsWith('/')||/[:\u0000-\u001f]/u.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..')
   ||!entry.reason.trim()||entry.reason.length>4000||seen.has(path.toLowerCase()))return null;
  seen.add(path.toLowerCase());result.push({path,reason:entry.reason.trim()});
 }
 return result;
}

export function sourceRetirementIssues(retired:RetiredSource[],archive:Record<string,Uint8Array>,inspection:ProjectInspection,decisions:ToolDecision[],skillFile:string):string[]{
 const migrated=new Set(decisions.map(decision=>decision.toolId));
 return retired.flatMap(({path})=>{
  const issues:string[]=[];
  if(!Object.hasOwn(archive,path))issues.push(`退役源文件不存在：${path}`);
  if(path===skillFile||!/\.(?:py|java|js|mjs|cjs|ts)$/iu.test(path)||/(?:^|\/)(?:references|assets|workspace|\.diagnosis-supplements)\//u.test(path))issues.push(`退役清单只能声明原实现代码，不包含文档、配置或业务资源：${path}`);
  if(inspection.tools.some(tool=>!migrated.has(tool.toolId)&&tool.sourcePaths.includes(path))
   ||inspection.dependencyAnalysis?.dependencies.some(dep=>(dep.resolvedPaths??[]).includes(path)&&dep.toolIds.some(id=>!migrated.has(id))))issues.push(`源文件仍被未迁移工具使用：${path}`);
  return issues;
 });
}
