import { strToU8 } from 'fflate';
import type { SkillAssetRecord } from './skill-store.js';
import { recommendLanguage,type ProjectInspection,type ToolDecision } from './migration-model.js';
import type { GeneratedToolImplementation } from './migration-code-generator.js';
import { normalizeSkillPackage } from './skill-normalizer.js';

export type PortableGeneration={toolId:string;toolName:string;form:ToolDecision['form'];files:string[];entrypoint?:string;
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
 * `skills/enterprise-migration/references/service-templates.md`.
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
  const migratedSources=new Set(input.decisions.flatMap(decision=>
    input.inspection.tools.find(tool=>tool.toolId===decision.toolId)?.sourcePaths??[]));
  const sourceArchive=Object.fromEntries(Object.entries(input.archive).filter(([name])=>!migratedSources.has(name)));
  const normalizedSkill=normalizeSkillPackage(sourceArchive,input.base.skillFile,input.base.skillId,input.version);
  for(const [name,bytes] of Object.entries(normalizedSkill.files))files[hasMcp?`skill/${name}`:name]=bytes;
  const skillTarget=hasMcp?'skill/SKILL.md':'SKILL.md';
  if(!files[skillTarget])throw Object.assign(new Error('标准迁移输入缺少 skill/SKILL.md'),{statusCode:409});

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
    // The Skill layout owns where a Script lives; the file itself is the agent's.
    const base=`${hasMcp?'skill/':''}scripts/`;
    // Node only treats a bare .js as ESM when a package.json says so, and the platform runs
    // the entrypoint as `node <path>`. A single file therefore ships as .mjs.
    const target=language==='python'
      ?(multi?`${base}${module}/${packagePath(implementation.sourcePath)}`:`${base}${module}.py`)
      :(multi?`${base}${module}/${packagePath(implementation.sourcePath)}`:`${base}${module}.mjs`);
    const written:{path:string;content:string}[]=entries.map((file,index)=>({
      path:multi?`${base}${module}/${packagePath(file.path)}`:target,
      content:index===0&&language==='python'?withPep723(file.content,dependencies):file.content,
    }));
    const manifest=[...written];
    if(multi&&language==='node'&&!entries.some(file=>file.path.endsWith('package.json')))
      manifest.push({path:`${base}${module}/package.json`,content:'{\n  "type": "module"\n}\n'});
    const lock=input.archive[`${implementation.sourcePath}.lock`];
    if(lock)manifest.push({path:`${target}.lock`,content:Buffer.from(lock).toString('utf8')});
    const paths=claim(manifest);
    generations.push({toolId:tool.toolId,toolName:tool.name,form:decision.form,files:paths,entrypoint:target,readyForValidation:true,todo:[],
      ...('generatedBy' in implementation?{generatedBy:implementation.generatedBy,explanation:implementation.explanation,
        attempts:implementation.attempts,checks:implementation.checks,
        ...(implementation.drift?.length?{drift:implementation.drift}:{}),
        ...(implementation.changes?.length?{changes:implementation.changes}:{})}:{})});
  }

  const diff:PortableDiff[]=Object.entries(files).flatMap(([name,bytes])=>{
    const before=input.archive[name]??input.archive[`skill/${name}`];
    if(before&&Buffer.compare(Buffer.from(before),Buffer.from(bytes))===0)return [];
    return [{path:name,operation:before?'MODIFY':'ADD',before:before?Buffer.from(before).toString('utf8'):'',after:Buffer.from(bytes).toString('utf8')} as PortableDiff];
  });
  return {files,generations,diff};
}
