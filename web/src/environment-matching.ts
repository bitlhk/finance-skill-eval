import type {EnvironmentInspection, MigrationRuntime} from './types';
import {launcherCompatibility} from './launcher-compatibility';

export type EnvironmentMatch = {runtime:MigrationRuntime; issues:string[]};
export function matchEnvironments(runtimes:MigrationRuntime[], tools:string[]):EnvironmentMatch[]{
  return runtimes.map(runtime=>{
    const inspection=runtime.inspection;
    const issues=inspectionIssues(inspection,tools);
    return {runtime,issues};
  });
}

export function inspectionIssues(inspection:EnvironmentInspection|undefined,tools:string[]):string[]{
  if(!inspection)return ['尚未取得环境能力，请刷新目录'];
  if(inspection.status!=='ready')return [inspection.error||'环境预检未通过'];
  const issues=launcherCompatibility(inspection.capabilities,tools);
  const provided=new Set([...(inspection.capabilities?.nativeToolNames??[]),...inspection.tools.map(tool=>tool.name)]);
  const missing=tools.filter(tool=>!provided.has(tool));
  if(missing.length&&!issues.some(issue=>issue.startsWith('缺少已准入工具')))issues.push(`缺少已准入工具：${missing.join('、')}`);
  return issues;
}

/** Preserve explicit choices; ambiguity is not permission to choose a data source. */
export function chooseEnvironment(matches:EnvironmentMatch[],family:MigrationRuntime['runtimeType'],current:string):string{
  const compatible=matches.filter(item=>item.runtime.runtimeType===family&&!item.issues.length);
  if(compatible.some(item=>item.runtime.runtimeId===current))return current;
  return compatible.length===1?compatible[0]!.runtime.runtimeId:'';
}
