import {createHash} from 'node:crypto';
import path from 'node:path';
import {SourceEvidenceValidator} from './source-evidence.js';
import {z} from 'zod';
import {verifyDependencyLibrary,type DependencyLibrary,type RuntimeLibraryInventory} from './dependency-library.js';
import {validServiceEnvironmentName} from './service-environment.js';
import type {ProjectInspection} from './migration-model.js';

export type DependencyEvidence={path:string;line:number;snippet:string};
export type Dependency={library?:DependencyLibrary;id:string;key:string;name:string;kind:'DATA'|'SDK'|'CONFIG'|'RESOURCE';owner:'TOOL'|'RUNTIME'|'UNKNOWN';action:'KEEP'|'INJECT'|'MOVE_TO_RUNTIME';contractStatus:'KNOWN'|'UNKNOWN';sensitive:boolean;binding:{kind:'HTTP_HEADER'|'SCRIPT_CONTEXT'|'SERVICE_ENV';name:string}|null;toolIds:string[];purpose:string;availability:'AVAILABLE'|'MISSING'|'UNKNOWN';provided:'NONE'|'PENDING'|'CONFIRMED'|'INVALID';blocking:boolean;evidence:DependencyEvidence[];resolvedPaths:string[];schema:Record<string,unknown>|null;schemaCompleteness:'UNKNOWN'|'PARTIAL'|'COMPLETE';issue?:string};
export type ToolChain={toolId:string;nodes:Array<{id:string;title:string;detail:string;dependencyIds:string[];evidence:DependencyEvidence[]}>;edges:Array<{from:string;to:string;condition?:string}>};
export type DependencyAnalysis={status:'COMPLETE'|'PARTIAL'|'UNAVAILABLE';revision:number;materialsDigest:string;reason?:string;dependencies:Dependency[];chains:ToolChain[];rejectedClaims:number};
export type Supplement={dependencyId:string;kind:Dependency['kind'];value?:unknown;files?:Record<string,string>;filename?:string;updatedAt:string};
export type AnalysisSupplement={dependencyId:string;key:string;kind:Dependency['kind'];provided:true;paths:string[]};

const citation=z.object({path:z.string().min(1),snippet:z.string().min(8)});
const wireLibrary=z.object({type:z.enum(['STANDARD_LIBRARY','PACKAGE','CUSTOM_SDK','UNKNOWN']),language:z.enum(['python','node']),module:z.string().min(1).max(200),packageName:z.string().min(1).max(200).nullish().transform(v=>v??undefined),version:z.string().max(200).nullish().transform(v=>v??undefined),declarationPaths:z.array(z.string()).max(20).nullish().transform(v=>v??[])});
const wireDependency=z.object({library:z.preprocess(v=>v&&typeof v==='object'&&(v as {type?:unknown}).type==='UNKNOWN'&&(!(v as {module?:unknown}).module||!(v as {language?:unknown}).language)?undefined:v,wireLibrary.nullish()).transform(v=>v??undefined),key:z.string().min(1).max(200),name:z.string().min(1).max(200),kind:z.enum(['DATA','SDK','CONFIG','RESOURCE']),owner:z.enum(['TOOL','RUNTIME','UNKNOWN']).default('UNKNOWN'),action:z.enum(['KEEP','INJECT','MOVE_TO_RUNTIME']).default('KEEP'),contractStatus:z.enum(['KNOWN','UNKNOWN']).default('UNKNOWN'),sensitive:z.boolean().default(true),binding:z.object({kind:z.enum(['HTTP_HEADER','SCRIPT_CONTEXT','SERVICE_ENV']),name:z.string().min(1).max(100)}).nullable().default(null),purpose:z.string().min(1).max(2000),blocking:z.boolean().default(true),availability:z.enum(['AVAILABLE','MISSING','UNKNOWN']),references:z.array(citation.extend({toolName:z.string()})).min(1).max(100),resolvedPaths:z.array(z.string()).default([]),resolutionEvidence:z.array(citation).default([]),schema:z.record(z.unknown()).nullable().default(null),schemaCompleteness:z.enum(['UNKNOWN','PARTIAL','COMPLETE']).default('UNKNOWN'),schemaEvidence:z.array(citation).default([])});
const wireChain=z.object({toolName:z.string(),nodes:z.array(z.object({id:z.string(),title:z.string(),detail:z.string(),dependencyKeys:z.array(z.string()).default([]),evidence:z.array(citation).min(1)})).max(100),edges:z.array(z.object({from:z.string(),to:z.string(),condition:z.string().nullable().optional().transform(value=>value??undefined)})).default([])});
const graphSchema=z.object({dependencies:z.array(wireDependency).max(200),chains:z.array(wireChain).max(100)});
export const dependencyId=(key:string,kind:string)=>'dep-'+createHash('sha256').update(kind+'\0'+key).digest('hex').slice(0,16);

/** Resolve against this invocation's trusted workspace and the actual asset file inventory. */
export function resolveDependencyPath(value:string,files:Record<string,string>,workspaceRoot?:string):{path:string}|{error:string} {
 if(!value||value.includes('\0'))return {error:'文件路径无效'};
 const windows=workspaceRoot?/^(?:[a-z]:|[\\/]{2})/iu.test(workspaceRoot):process.platform==='win32';
 const api=windows?path.win32:path.posix;
 const normalized=value.replaceAll('\\','/');
 const absolute=path.win32.isAbsolute(value)||path.posix.isAbsolute(normalized)||/^[a-z]:/iu.test(value);
 let relative=normalized;
 if(absolute){
  if(!workspaceRoot)return {error:'绝对路径缺少本次工程根目录，无法校验'};
  if(windows?!/^(?:[a-z]:[\\/]|[\\/]{2})/iu.test(value):!normalized.startsWith('/'))return {error:'文件路径不属于本次工程'};
  relative=api.relative(api.resolve(workspaceRoot),api.resolve(value)).replaceAll('\\','/');
 }
 relative=path.posix.normalize(relative);
 if(relative==='..'||relative.startsWith('../')||path.posix.isAbsolute(relative)||path.win32.isAbsolute(relative)||/^[a-z]:/iu.test(relative))return {error:'文件路径不在本次工程内'};
 const matches=Object.keys(files).filter(key=>{const candidate=path.posix.normalize(key.replaceAll('\\','/'));return windows?candidate.toLowerCase()===relative.toLowerCase():candidate===relative});
 if(matches.length>1)return {error:'文件路径对应多个工程文件，无法唯一定位'};
 if(!matches.length)return {error:'工程中不存在该文件'};
 return {path:matches[0]!};
}

function locate(claim:{path:string;snippet:string},files:Record<string,string>,workspaceRoot:string|undefined,validator:SourceEvidenceValidator):DependencyEvidence|null {
 const result=resolveDependencyPath(claim.path,files,workspaceRoot);if('error' in result)return null;
 const at=validator.find(result.path,claim.snippet);if(!at)return null;
 return {path:at.path,line:at.line,snippet:claim.snippet};
}

/** Structural validation only. No values are sent to the analysis model. */
export function validateDependencyData(value:unknown,schema:Record<string,unknown>|null,at='数据',depth=0):string[] {
 if(!schema)return [];
 if(depth>32)return ['数据结构超过校验深度限制'];
 const errors:string[]=[];const type=schema.type;
 const matches=(t:unknown)=>t==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):t==='array'?Array.isArray(value):t==='integer'?typeof value==='number'&&Number.isInteger(value):t==='null'?value===null:t==='number'?typeof value==='number':t==='string'?typeof value==='string':t==='boolean'?typeof value==='boolean':false;
 if(type!==undefined&&!(Array.isArray(type)?type.some(matches):matches(type)))return [`${at} 应为 ${Array.isArray(type)?type.join(' / '):String(type)}`];
 if(Array.isArray(schema.enum)&&!schema.enum.some(x=>JSON.stringify(x)===JSON.stringify(value)))errors.push(`${at} 不在允许值中`);
 if(value!==null&&typeof value==='object'&&!Array.isArray(value)){
  const obj=value as Record<string,unknown>,props=(schema.properties??{}) as Record<string,Record<string,unknown>>;
  if(typeof props!=='object'||Array.isArray(props))return ['依赖类型定义无效，请补充契约说明后继续分析'];
  for(const key of (Array.isArray(schema.required)?schema.required:[]))if(typeof key==='string'&&!(key in obj))errors.push(`${at} 缺少 ${key}`);
  for(const [key,v] of Object.entries(obj)){if(Object.prototype.hasOwnProperty.call(props,key)&&props[key])errors.push(...validateDependencyData(v,props[key],`${at}.${key}`,depth+1));else if(schema.additionalProperties===false)errors.push(`${at} 不允许字段 ${key}`)}
 }
 if(Array.isArray(value)&&schema.items&&typeof schema.items==='object')value.forEach((v,i)=>errors.push(...validateDependencyData(v,schema.items as Record<string,unknown>,`${at}[${i}]`,depth+1)));
 return errors;
}

export function analyzeDependencies(payload:unknown,inspection:ProjectInspection,files:Record<string,string>,supplements:Supplement[],revision:number,materialsDigest:string,workspaceRoot?:string,libraryInventory?:RuntimeLibraryInventory):DependencyAnalysis {
 const raw=payload as {dependencyAnalysis?:unknown;reason?:string};const parsed=graphSchema.safeParse(raw?.dependencyAnalysis);
 if(!parsed.success)return {status:'UNAVAILABLE',revision,materialsDigest,reason:'当前分析尚未提供完整链路与依赖，请重新分析。',dependencies:[],chains:[],rejectedClaims:0};
 const validator=new SourceEvidenceValidator(files);
 const runtimeCapabilityNames=new Set((inspection.runtimeCapabilities??[]).map(capability=>capability.name));
 let rejected=0;const dependencies:Dependency[]=[];const keys=new Set<string>();
 for(const item of parsed.data.dependencies){
  const migrationReferences=item.references.filter(ref=>!runtimeCapabilityNames.has(ref.toolName));
  // Runtime Harness capabilities are explicitly outside the migration graph. Their implementation
  // details (for example pathlib inside read_document) neither need migration nor user supplements.
  if(!migrationReferences.length)continue;
  if(keys.has(item.key)){rejected++;continue}keys.add(item.key);
  const refs=migrationReferences.flatMap(ref=>{const tool=inspection.tools.find(t=>t.name===ref.toolName);const e=locate(ref,files,workspaceRoot,validator);return tool&&e?[{toolId:tool.toolId,e}]:[]});
  rejected+=migrationReferences.length-refs.length;
  // Each rejected reference is already counted above. Do not count the containing dependency a
  // second time merely because none of its references survived validation.
  if(!refs.length)continue;
  const id=dependencyId(item.key,item.kind),provided=supplements.find(s=>s.dependencyId===id&&s.kind===item.kind);
  const schemaEvidence=item.schemaEvidence.flatMap(c=>{const e=locate(c,files,workspaceRoot,validator);return e?[e]:[]});
  rejected+=item.schemaEvidence.length-schemaEvidence.length;
  const schema=schemaEvidence.length===item.schemaEvidence.length&&schemaEvidence.length?item.schema:null;
  const completeness=schema?item.schemaCompleteness:'UNKNOWN';
  const resolutions=item.resolutionEvidence.flatMap(c=>{const e=locate(c,files,workspaceRoot,validator);return e?[e]:[]});rejected+=item.resolutionEvidence.length-resolutions.length;
  const pathResults=item.resolvedPaths.map(p=>resolveDependencyPath(p,files,workspaceRoot));
  const pathErrors=pathResults.flatMap(r=>'error' in r?[r.error]:[]);
  const resolvedPaths=[...new Set(pathResults.flatMap(r=>'path' in r&&[...refs.map(ref=>ref.e),...resolutions].some(e=>e.path===r.path)?[r.path]:[]))];
  const library=item.kind==='SDK'?verifyDependencyLibrary(item.library?{...item.library,declarationPaths:item.library.declarationPaths.flatMap(p=>{const result=resolveDependencyPath(p,files,workspaceRoot);return 'path' in result?[result.path]:[]})}:undefined,[...refs.map(ref=>ref.e),...resolutions],files,libraryInventory):undefined;
  let availability=item.availability;if(availability==='AVAILABLE'&&!resolvedPaths.length&&!library?.verified)availability='UNKNOWN';
  if(library?.verified)availability='AVAILABLE';
  let status:Dependency['provided']=provided?'PENDING':'NONE',issue:string|undefined=pathErrors.length?[...new Set(pathErrors)].join('；'):undefined;
  if(provided?.files&&item.availability==='AVAILABLE'&&resolvedPaths.some(p=>p in provided.files!)){status='CONFIRMED';availability='AVAILABLE'}
  if(provided&&'value' in provided){const errors=validateDependencyData(provided.value,schema);if(errors.length){status='INVALID';issue=errors.join('；')}else if(schema&&completeness==='COMPLETE'){status='CONFIRMED';availability='AVAILABLE'}else{issue='数据已提供，完整类型仍待确认';availability='UNKNOWN'}}
  const validBoundary=item.owner==='RUNTIME'?item.action!=='KEEP':item.owner==='TOOL'?item.action==='KEEP':false;
  const validServiceBinding=item.binding?.kind!=='SERVICE_ENV'||(item.owner==='RUNTIME'&&item.action==='INJECT'&&item.kind==='CONFIG'&&validServiceEnvironmentName(item.binding.name)&&['string','number','integer','boolean'].includes(String(schema?.type)));
  const contractStatus=validServiceBinding&&validBoundary&&item.contractStatus==='KNOWN'&&(item.owner!=='RUNTIME'||item.action!=='INJECT'||item.binding!==null)?'KNOWN':'UNKNOWN';
  dependencies.push({...(library?{library}:{}),id,key:item.key,name:item.name,kind:item.kind,owner:item.owner,action:item.action,contractStatus,sensitive:item.sensitive,binding:item.binding,purpose:item.purpose,toolIds:[...new Set(refs.map(r=>r.toolId))],blocking:item.blocking,availability,provided:status,evidence:[...refs.map(r=>r.e),...schemaEvidence,...resolutions],resolvedPaths,schema,schemaCompleteness:completeness,...(issue?{issue}:{})});
 }
 const chains:ToolChain[]=[];
 for(const chain of parsed.data.chains){if(runtimeCapabilityNames.has(chain.toolName))continue;const tool=inspection.tools.find(t=>t.name===chain.toolName);if(!tool){rejected++;continue}if(chains.some(c=>c.toolId===tool.toolId)){rejected++;continue}
  const nodeIds=new Set<string>();const nodes=chain.nodes.flatMap(n=>{const evidence=n.evidence.flatMap(c=>{const e=locate(c,files,workspaceRoot,validator);return e?[e]:[]});rejected+=n.evidence.length-evidence.length;const deps=n.dependencyKeys.map(k=>dependencies.find(d=>d.key===k&&d.toolIds.includes(tool.toolId))?.id);if(!evidence.length||nodeIds.has(n.id)||deps.some(d=>!d)){rejected++;return []}nodeIds.add(n.id);return [{id:n.id,title:n.title,detail:n.detail,dependencyIds:deps as string[],evidence}]});
  const edges=chain.edges.filter(e=>{const valid=nodeIds.has(e.from)&&nodeIds.has(e.to);if(!valid)rejected++;return valid}).map(({from,to,condition})=>({from,to,...(condition===undefined?{}:{condition})}));chains.push({toolId:tool.toolId,nodes,edges});
 }
 const partial=rejected>0||inspection.tools.some(t=>!chains.some(c=>c.toolId===t.toolId&&c.nodes.length))||dependencies.some(d=>d.blocking&&(d.owner==='UNKNOWN'||d.contractStatus!=='KNOWN'||(d.owner==='TOOL'&&(d.availability!=='AVAILABLE'||d.provided==='INVALID'))));
 return {status:partial?'PARTIAL':'COMPLETE',revision,materialsDigest,dependencies,chains,rejectedClaims:rejected,...(raw.reason?{reason:raw.reason}:{})};
}
