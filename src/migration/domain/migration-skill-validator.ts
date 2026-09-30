import { parse as parseYaml } from 'yaml';
import type { SkillFinding,SkillInspection } from './migration-model.js';

function lineOf(source:string,index:number){return source.slice(0,index).split(/\r?\n/u).length;}
function finding(code:string,severity:SkillFinding['severity'],path:string,line:number,message:string,suggestion:string):SkillFinding{
  return {code,severity,path,line,message,suggestion};
}

export function validateSkill(files:Record<string,string>,skillFile:string):SkillInspection{
  const source=files[skillFile];
  if(source===undefined)return {status:'UNKNOWN',findings:[finding('SKILL_FILE_UNREADABLE','ERROR',skillFile,1,'无法读取 SKILL.md。','请提供 UTF-8 文本文件。')]};
  const findings:SkillFinding[]=[];
  const skillFiles=Object.keys(files).filter(name=>/(^|\/)skill\.md$/iu.test(name));
  if(skillFile.split('/').at(-1)!=='SKILL.md')
    findings.push(finding('SKILL_FILENAME_INVALID','ERROR',skillFile,1,'Skill 入口文件必须准确命名为 SKILL.md。','将文件名改为区分大小写的 SKILL.md。'));
  if(skillFiles.length!==1)
    findings.push(finding('SKILL_FILE_COUNT_INVALID','ERROR',skillFile,1,'Skill 包必须且只能包含一个 SKILL.md。','移除重复入口；多个 Skill 请分别打包。'));
  const match=source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u);
  let metadata:Record<string,unknown>={};
  if(!match){findings.push(finding('FRONTMATTER_MISSING','ERROR',skillFile,1,'SKILL.md 缺少 YAML frontmatter。','在文件开头添加 name 和 description。'));}
  else try{const value=parseYaml(match[1]!);if(value&&typeof value==='object'&&!Array.isArray(value))metadata=value as Record<string,unknown>;
    else throw new Error('invalid');}catch{findings.push(finding('FRONTMATTER_INVALID','ERROR',skillFile,1,'YAML frontmatter 无法解析。','修正 YAML 格式。'));}
  const name=typeof metadata.name==='string'?metadata.name:'';
  const description=typeof metadata.description==='string'?metadata.description.trim():'';
  if(!name)findings.push(finding('NAME_REQUIRED','ERROR',skillFile,1,'缺少 Skill name。','添加小写、数字和连字符组成的 name。'));
  else if(name.length>64||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))findings.push(finding('NAME_INVALID','ERROR',skillFile,1,'Skill name 不符合 Agent Skills 命名规则。','使用 1–64 个小写字母、数字或单连字符。'));
  if(!description)findings.push(finding('DESCRIPTION_REQUIRED','ERROR',skillFile,1,'缺少 Skill description。','说明 Skill 做什么以及什么时候使用。'));
  else if(description.length>1024)findings.push(finding('DESCRIPTION_TOO_LONG','ERROR',skillFile,1,'Skill description 超过 1024 个字符。','缩短描述。'));
  const root=skillFile.includes('/')?skillFile.slice(0,skillFile.lastIndexOf('/')):'';
  const prefix=root?`${root}/`:'';
  const scoped=root?Object.keys(files).filter(file=>file!==skillFile&&file.startsWith(prefix)):[];
  for(const file of scoped){
    const relative=file.slice(prefix.length),top=relative.split('/')[0]!;
    if(['scripts','references','assets'].includes(top))continue;
    const script=/\.(?:py|js|mjs|cjs|ts|sh|ps1|bat|cmd)$/iu.test(relative);
    findings.push(finding(script?'SCRIPT_OUTSIDE_SCRIPTS':'SKILL_PATH_UNSUPPORTED','ERROR',file,1,
      script?'Skill 自带脚本必须放在 scripts/ 目录中。':'Skill 目录中只允许 SKILL.md、scripts/、references/ 和 assets/。',
      script?`将 ${relative} 移到 scripts/ 下。`:'将文件移到合适的标准目录，或从 Skill 目录移除。'));
  }
  for(const ref of source.matchAll(/`((?:scripts|references|assets)\/[^`]+)`/gu)){
    const requested=root?`${root}/${ref[1]}`:ref[1]!;
    if(!(requested in files))findings.push(finding('REFERENCE_MISSING','ERROR',skillFile,lineOf(source,ref.index),`引用文件不存在：${ref[1]}`,'补充文件或修正相对路径。'));
  }
  for(const hit of source.matchAll(/(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"'\n]+["']/giu))
    findings.push(finding('INLINE_SECRET','ERROR',skillFile,lineOf(source,hit.index),'Skill 中疑似包含明文凭据。','移除凭据并由运行环境安全提供。'));
  for(const hit of source.matchAll(/(?:[A-Za-z]:\\|\/(?:Users|home|opt|var)\/)[^\s`)]+/gu))
    findings.push(finding('ABSOLUTE_PATH','WARNING',skillFile,lineOf(source,hit.index),'Skill 中包含机器专用绝对路径。','改用 Skill 目录内的相对路径。'));
  if(!/(失败|错误|不可用|缺少|缺失|拒绝|fail|error|missing|reject)/iu.test(source))
    findings.push(finding('FAILURE_HANDLING_UNCLEAR','INFO',skillFile,1,'没有找到异常情况的处理说明。','补充工具调用失败、信息不足或请求被拒绝时的处理方式。'));
  return {status:findings.some(f=>f.severity==='ERROR')?'NON_COMPLIANT':'COMPLIANT',findings};
}
