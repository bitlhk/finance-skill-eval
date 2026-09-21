import {runtimeToolConfigTemplate} from './migration-delivery-contract.js';
import { strToU8 } from 'fflate';
import {posix} from 'node:path';
import type { SkillAssetRecord } from './skill-store.js';
import { recommendLanguage,type ProjectInspection,type ToolDecision } from './migration-model.js';
import type { GeneratedToolImplementation } from './migration-code-generator.js';
import { normalizeSkillPackage } from './skill-normalizer.js';

export type PortableGeneration={toolId:string;toolName:string;form:ToolDecision['form'];files:string[];entrypoint?:string;
  callExecuted?:boolean;runtimeDependenciesPending?:string[];
  runtimeBindings?:GeneratedToolImplementation['runtimeBindings'];
  /** How to start it. The code is the agent's, so how to run it is the agent's answer too. */
  start?:string[];prepare?:string[];
  /** What moved relative to the baseline and why. Carried to the report so a human can judge the
   * adaptation; it never blocks the package. */
  drift?:GeneratedToolImplementation['drift'];changes?:GeneratedToolImplementation['changes'];
  readyForValidation:boolean;todo:string[];generatedBy?:string;explanation?:string;attempts?:number;
  checks?:GeneratedToolImplementation['checks']};
export type PortableDiff={path:string;operation:'ADD'|'MODIFY';before:string;after:string};

/**
 * The candidate package is assembled, not generated.
 *
 * Everything that runs -- an MCP service and its adapters, a Script program -- is written by the
 * A4 agent, which also starts it and contract-tests it inside its own loop. The platform's part
 * is the Skill package layout, path safety, and the diff. It used to generate the services from
 * templates, which left the agent filling a hole the platform had dug: it could not restructure
 * the service or decide how to run it, and the Schema the service advertised was the platform's
 * reading rather than what the agent had built.
 *
 * The shapes the agent writes against are in the skill package:
 * `skills/enterprise-migration-delivery/references/service-templates.md`.
 */
const pythonName=(name:string)=>identifier(name.toLowerCase().replace(/[^a-z0-9_]+/gu,'_').replace(/^_+|_+$/gu,'')||'tool','tool_');
const nodeName=(name:string)=>identifier(name.toLowerCase().replace(/[^a-z0-9]+/gu,'-').replace(/^-+|-+$/gu,'')||'tool','tool-');
function identifier(value:string,fallback:string){return `${/^[a-zA-Z]/u.test(value)?'':fallback}${value}`;}

const withPep723=(source:string,dependencies:string[]=[])=>/^#\s*\/\/\/\s*script\s*$/mu.test(source)?source:`# /// script\n# requires-python = ">=3.11"\n# dependencies = [${dependencies.map(value=>JSON.stringify(value)).join(', ')}]\n# ///\n\n${source}`;

/** A path the agent reported is about to become a file in the package. Nothing may leave it. */
function packagePath(path:string):string{
  const normalized=path.replaceAll('\\','/').replace(/^\.\//u,'');
  if(!normalized||normalized.startsWith('/')||/^[a-zA-Z]:/u.test(normalized)||normalized.split('/').includes('..'))
    throw Object.assign(new Error(`生成文件路径不合法：${path}`),{statusCode:409});
  return normalized;
}

const MAX_INLINE_SKILL_LINES=500;
function lines(value:string){return value.replaceAll('\r\n','\n').split('\n').length;}
function compactShortReferences(files:Record<string,Uint8Array>,skillTarget:string){
  const root=skillTarget.slice(0,skillTarget.length-'SKILL.md'.length);
  const references=Object.keys(files).filter(name=>name.startsWith(`${root}references/`)&&/\.md$/iu.test(name)).sort();
  if(!references.length)return;
  let skill=Buffer.from(files[skillTarget]!).toString('utf8');
  const material=references.map(path=>({path,content:Buffer.from(files[path]!).toString('utf8').trim()}));
  if(lines(skill)+material.reduce((sum,item)=>sum+lines(item.content)+3,0)>MAX_INLINE_SKILL_LINES)return;
  for(const item of material){
    const relative=item.path.slice(root.length),basename=posix.basename(relative,'.md');
    const heading=item.content.match(/^#\s+(.+)$/mu)?.[1]?.trim()||basename.replaceAll('-',' ');
    const body=item.content.replace(/^#\s+.+\r?\n+/u,'').trim();
    const escaped=relative.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
    skill=skill
      .replace(new RegExp(`(?:请)?(?:阅读|参见|查看)\\s*[\`“\"]?${escaped}[\`”\"]?[。.]?`,'giu'),'')
      .replaceAll(`\`${relative}\``,heading)
      .replaceAll(`](${relative})`,']');
    if(body)skill+=`\n\n## ${heading}\n\n${body}`;
    delete files[item.path];
  }
  files[skillTarget]=strToU8(skill.trimEnd()+'\n');
}

/** Remove Python package markers whose package no longer contains implementation files. */
function pruneOrphanPythonPackageMarkers(files:Record<string,Uint8Array>){
  const markers=Object.keys(files)
    .filter(name=>/(?:^|\/)__init__\.py$/u.test(name)&&!Buffer.from(files[name]!).toString('utf8').trim())
    .sort((left,right)=>right.split('/').length-left.split('/').length);
  for(const marker of markers){
    const directory=marker.slice(0,marker.lastIndexOf('/')+1);
    if(!Object.keys(files).some(name=>name!==marker&&name.startsWith(directory)))delete files[marker];
  }
}

/** An existing implementation that already satisfies the target form can be reused as-is. */
function reusable(tool:ProjectInspection['tools'][number],archive:Record<string,Uint8Array>,language:'python'|'node'){
  const kind=language==='node'?'NODE':'PYTHON';
  if(tool.portability!=='PORTABLE_SCRIPT'||tool.entrypoint?.kind!==kind)return null;
  const bytes=archive[tool.entrypoint.path];
  return bytes?{language,sourcePath:tool.entrypoint.path,source:Buffer.from(bytes).toString('utf8'),additionalFiles:[],dependencies:[]}:null;
}

export function generatePortableCandidate(input:{archive:Record<string,Uint8Array>;base:SkillAssetRecord;inspection:ProjectInspection;decisions:ToolDecision[];version:string;implementations?:Record<string,GeneratedToolImplementation>}){
  const implementations=input.implementations??{};
  const files:Record<string,Uint8Array>={},generations:PortableGeneration[]=[];
  const hasMcp=input.decisions.some(decision=>decision.form==='MCP');
  // A Tool being migrated is replaced, not carried alongside. Shipping the
  // runtime-coupled original next to its replacement would defeat the migration.
  // sourcePaths also contains citations (SKILL.md, policies, data). It is not a deletion list.
  // Only implementation code exclusively owned by migrated tools can be replaced.
  const migratedIds=new Set(input.decisions.map(decision=>decision.toolId));
  const graphDependencies=input.inspection.dependencyAnalysis?.dependencies??[];
  const exclusivelyMigrated=(path:string)=>graphDependencies.every(dep=>!(dep.resolvedPaths??[]).includes(path)||dep.toolIds.every(id=>migratedIds.has(id)));
  const retiredRuntimeSources=new Set(graphDependencies.filter(dep=>dep.owner==='RUNTIME'&&dep.action==='MOVE_TO_RUNTIME'&&dep.toolIds.every(id=>migratedIds.has(id)))
    .flatMap(dep=>dep.resolvedPaths??[]).filter(path=>exclusivelyMigrated(path)
      &&input.inspection.tools.every(tool=>!tool.sourcePaths.includes(path)||migratedIds.has(tool.toolId))
      &&!graphDependencies.some(dep=>dep.owner==='TOOL'&&(dep.resolvedPaths??[]).includes(path))));
  const migratedSources=new Set(input.decisions.flatMap(decision=>
    input.inspection.tools.find(tool=>tool.toolId===decision.toolId)?.sourcePaths??[])
    .filter(name=>name!==input.base.skillFile&&/\.(?:java|py|js|mjs|cjs|ts)$/iu.test(name)
      &&!/(?:^|\/)(?:references|assets)\//u.test(name)
      &&input.inspection.tools.every(tool=>!tool.sourcePaths.includes(name)||migratedIds.has(tool.toolId))));
  // Supplementary source and explanations are analysis inputs. A4 must place any required
  // implementation in its delivered engineering files; never publish the raw intake area.
  const skillRoot=input.base.skillFile.includes('/')?input.base.skillFile.slice(0,input.base.skillFile.lastIndexOf('/')+1):'';
  const isWorkspaceData=(name:string)=>{
    const relative=skillRoot&&name.startsWith(skillRoot)?name.slice(skillRoot.length):name;
    return relative.startsWith('workspace/')||relative.startsWith('references/workspace/');
  };
  const sourceArchive=Object.fromEntries(Object.entries(input.archive).filter(([name])=>!migratedSources.has(name)&&!retiredRuntimeSources.has(name)&&!name.startsWith('.diagnosis-supplements/')&&!isWorkspaceData(name)));
  const normalizedSkill=normalizeSkillPackage(sourceArchive,input.base.skillFile,input.base.skillId,input.version);
  pruneOrphanPythonPackageMarkers(normalizedSkill.files);
  for(const [name,bytes] of Object.entries(normalizedSkill.files))files[hasMcp?`skill/${name}`:name]=bytes;
  const skillTarget=hasMcp?'skill/SKILL.md':'SKILL.md';
  if(!files[skillTarget])throw Object.assign(new Error('标准迁移输入缺少 skill/SKILL.md'),{statusCode:409});
  const relocations=new Map<string,Set<string>>();
  const relocated=(from:string,to:string)=>{const targets=relocations.get(from)??new Set<string>();targets.add(to);relocations.set(from,targets);};
  const replacedResources=new Set<string>();

  // Tools that share one MCP service each declare that service's files, so the same path arriving
  // twice is normal -- as long as it is the same bytes. Two Tools disagreeing about a file they
  // both ship is not: one would silently win.
  const claim=(entries:Array<{path:string;content:string}>)=>{
    for(const entry of entries){
      const existing=files[entry.path];
      if(existing===undefined){files[entry.path]=strToU8(entry.content);continue;}
      if(Buffer.from(existing).toString('utf8')!==entry.content)
        throw Object.assign(new Error(`生成的 ${entry.path} 被两个 Tool 以不同内容声明；不会静默覆盖`),{statusCode:409});
    }
    return entries.map(entry=>entry.path);
  };
  for(const decision of input.decisions){
    const tool=input.inspection.tools.find(item=>item.toolId===decision.toolId);
    if(!tool)throw new Error(`Unknown Tool decision: ${decision.toolId}`);
    const language=decision.language??recommendLanguage(decision.form,tool.language);
    const generated=implementations[tool.toolId];
    const detailed=generated?.language===language?generated:null;

    if(decision.form==='MCP'){
      // The service, its adapters and its start command are the agent's. The platform only
      // refuses a package it cannot place: overlapping paths, or an implementation in a
      // language the human did not authorize.
      if(!detailed)throw Object.assign(new Error(
        `无法自动迁移 ${tool.name}：MCP 需要迁移模型产出完整的 ${language} 服务实现；不会生成占位代码`),{statusCode:409});
      const entries=[{path:detailed.sourcePath,content:detailed.source},...detailed.additionalFiles]
        .map(entry=>({path:packagePath(entry.path),content:entry.content}));
      const paths=claim(entries);
      generations.push({toolId:tool.toolId,toolName:tool.name,form:decision.form,files:paths,entrypoint:entries[0]!.path,
        ...(detailed.start?{start:detailed.start}:{}),...(detailed.prepare?{prepare:detailed.prepare}:{}),
        ...(detailed.drift?.length?{drift:detailed.drift}:{}),...(detailed.changes?.length?{changes:detailed.changes}:{}),
        readyForValidation:true,todo:[],generatedBy:detailed.generatedBy,
        ...(typeof detailed.callExecuted==='boolean'?{callExecuted:detailed.callExecuted}:{}),
        ...(detailed.runtimeDependenciesPending?{runtimeDependenciesPending:detailed.runtimeDependenciesPending}:{}),
        ...(detailed.runtimeBindings?{runtimeBindings:detailed.runtimeBindings}:{}),
        explanation:detailed.explanation,attempts:detailed.attempts,checks:detailed.checks});
      continue;
    }

    const reusableImplementation=reusable(tool,input.archive,language as 'python'|'node');
    const implementation=detailed??reusableImplementation;
    if(!implementation)throw Object.assign(new Error(
      `无法自动迁移 ${tool.name}：没有可独立执行的 ${language} 实现；不会生成占位代码`),{statusCode:409});
    const module=language==='node'?nodeName(tool.name):pythonName(tool.name);
    const extra='additionalFiles' in implementation?implementation.additionalFiles:[];
    const dependencies='dependencies' in implementation?implementation.dependencies:[];
    const entries=[{path:implementation.sourcePath,content:implementation.source},...extra],multi=entries.length>1;
    // Preserve relative relationships, but do not repeat the common source directory.
    const parents=entries.map(file=>packagePath(file.path).split('/').slice(0,-1));
    let prefixLength=0;while(prefixLength<parents[0]!.length&&parents.every(parts=>parts[prefixLength]===parents[0]![prefixLength]))prefixLength++;
    const prefix=parents[0]!.slice(0,prefixLength).join('/');
    const relative=(path:string)=>packagePath(path).slice(prefix?prefix.length+1:0);
    // The Skill layout owns where a Script lives; the file itself is the agent's.
    const base=`${hasMcp?'skill/':''}scripts/`;
    // A4 has already compiled and contract-tested its declared package layout. Preserve that
    // layout when it is already under scripts/: moving the entrypoint one directory deeper can
    // silently break __file__/import.meta.url resource lookups after the contract has passed.
    const preserveDeclaredLayout=Boolean(detailed?.generatedBy)&&entries.every(file=>packagePath(file.path).startsWith('scripts/'));
    // Node only treats a bare .js as ESM when a package.json says so, and the platform runs
    // the entrypoint as `node <path>`. A single non-A4 file therefore ships as .mjs.
    const target=preserveDeclaredLayout
      ?`${hasMcp?'skill/':''}${packagePath(implementation.sourcePath)}`
      :language==='python'
       ?(multi?`${base}${module}/${relative(implementation.sourcePath)}`:`${base}${module}.py`)
       :(multi?`${base}${module}/${relative(implementation.sourcePath)}`:`${base}${module}.mjs`);
    const written:{path:string;content:string}[]=entries.map((file,index)=>({
      path:preserveDeclaredLayout?`${hasMcp?'skill/':''}${packagePath(file.path)}`:multi?`${base}${module}/${relative(file.path)}`:target,
      content:index===0&&language==='python'?withPep723(file.content,dependencies):file.content,
    }));
    const manifest=[...written];
    if(multi&&language==='node'&&!entries.some(file=>file.path.endsWith('package.json')))
      manifest.push({path:preserveDeclaredLayout?`${posix.dirname(target)}/package.json`:`${base}${module}/package.json`,content:'{\n  "type": "module"\n}\n'});
    const lock=input.archive[`${implementation.sourcePath}.lock`];
    if(lock)manifest.push({path:`${target}.lock`,content:Buffer.from(lock).toString('utf8')});
    const paths=claim(manifest);
    entries.forEach((entry,index)=>{
      relocated(packagePath(entry.path),written[index]!.path);
      if(index>0&&input.archive[entry.path]&&exclusivelyMigrated(entry.path)
        &&input.inspection.tools.every(other=>!other.sourcePaths.includes(entry.path)||migratedIds.has(other.toolId))
        &&graphDependencies.some(dep=>dep.owner==='TOOL'&&dep.toolIds.includes(tool.toolId)&&(dep.resolvedPaths??[]).includes(entry.path)))replacedResources.add(entry.path);
    });
    generations.push({toolId:tool.toolId,toolName:tool.name,form:decision.form,files:paths,entrypoint:target,readyForValidation:true,todo:[],
      ...('generatedBy' in implementation?{generatedBy:implementation.generatedBy,explanation:implementation.explanation,
        ...(typeof implementation.callExecuted==='boolean'?{callExecuted:implementation.callExecuted}:{}),
        ...(implementation.runtimeDependenciesPending?{runtimeDependenciesPending:implementation.runtimeDependenciesPending}:{}),
        attempts:implementation.attempts,checks:implementation.checks,
        ...(implementation.drift?.length?{drift:implementation.drift}:{}),
        ...(implementation.changes?.length?{changes:implementation.changes}:{})}:{})});
  }

  for(const source of replacedResources){
    const root=input.base.skillFile.includes('/')?input.base.skillFile.slice(0,input.base.skillFile.lastIndexOf('/')+1):'';
    const relative=source.startsWith(root)?source.slice(root.length):source;
    const normalized=normalizedSkill.moves.find(move=>move.from===relative)?.to??relative;
    const oldTarget=`${hasMcp?'skill/':''}${normalized}`;
    if(!generations.some(g=>g.files.includes(oldTarget)))delete files[oldTarget];
    for(const target of relocations.get(source)??[])relocated(normalized,target);
  }
  // Rewrite documentation in one pass, so replacements cannot rewrite each other.
  const replacements=[...relocations].filter(([,targets])=>targets.size===1);
  if(replacements.length){
    const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
    const pattern=new RegExp(`(?<![\\w./-])(?:${replacements.map(([from])=>escape(from)).sort((a,b)=>b.length-a.length).join('|')})(?![\\w./-])`,'gu');
    const targets=new Map(replacements.map(([from,to])=>[from,[...to][0]!]));
    for(const [name,bytes] of Object.entries(files))if(/\.md$/iu.test(name)){
      let content=Buffer.from(bytes).toString('utf8');
      for(const [from] of replacements)content=content.replaceAll(`${from} (missing in source package; migration could not restore it)`,`\`${from}\``);
      files[name]=strToU8(content.replace(pattern,from=>{
        return posix.relative(posix.dirname(name),targets.get(from)!);
      }));
    }
  }

  const guide = generations.map(g=>g.form==='SCRIPT'
    ? `- ${g.toolName}: 通过 command 执行；包内入口为 \`${g.entrypoint}\`，执行时使用 Runtime 提供的入口绝对路径。cwd 是 workspace，不能假设为 Skill 目录；包内资源基于脚本位置定位，业务输入和相对输出路径以 workspace 为基准。不支持额外上下文或凭证注入。`
    : `- ${g.toolName}: 通过 MCP 调用同名工具；服务参数从声明的环境变量读取，业务 arguments 与按调用 Runtime Header 分开，包级配置声明见 runtime-tool-config.template.json。`).join('\n');
  const originalInstructions=Buffer.from(files[skillTarget]!).toString('utf8');
  // Regeneration may start from the previous immutable candidate.  Remove the guide we own
  // before appending its replacement; otherwise every regeneration duplicates the section and
  // gradually drowns out the business instructions.
  const cleanInstructions=originalInstructions.replace(/\n## 迁移后的执行方式\n[\s\S]*?(?=\n## |\s*$)/u,'').trimEnd();
  files[skillTarget]=strToU8(cleanInstructions+'\n\n## 迁移后的执行方式\n\n'+guide+'\n'+
    '\n- 保持原 Skill 声明的业务输出字段和类型。当指令要求返回指定字段时，最终答案须包含一个 JSON 对象；空数组必须保持为 `[]`，不能改写成说明文字。\n');
  compactShortReferences(files,skillTarget);
  if(hasMcp){
    const templatePath='runtime-tool-config.template.json';
    const template=JSON.stringify(runtimeToolConfigTemplate(input.inspection,input.decisions),null,2)+'\n';
    if(files[templatePath]&&Buffer.from(files[templatePath]!).toString('utf8')!==template)throw Object.assign(new Error('交付包占用了 Runtime 配置模板路径且内容与诊断契约不一致'),{statusCode:409});
    files[templatePath]=strToU8(template);
  }

  const diff:PortableDiff[]=Object.entries(files).flatMap(([name,bytes])=>{
    // MCP delivery nests the normalized Skill below skill/.  Compare those files with the
    // corresponding source-relative path, not with skill/skill/<path>.  Treating preserved
    // references as generated ADD files made the next regeneration delete them.
    const sourceRelative=hasMcp&&name.startsWith('skill/')?name.slice('skill/'.length):name;
    const before=input.archive[name]??input.archive[sourceRelative];
    if(before&&Buffer.compare(Buffer.from(before),Buffer.from(bytes))===0)return [];
    return [{path:name,operation:before?'MODIFY':'ADD',before:before?Buffer.from(before).toString('utf8'):'',after:Buffer.from(bytes).toString('utf8')} as PortableDiff];
  });
  return {files,generations,diff};
}
