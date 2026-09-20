import { parse as parseYaml,stringify as stringifyYaml } from 'yaml';

const SCRIPT=/\.(?:py|js|mjs|cjs|ts|sh|ps1|bat|cmd)$/iu;
const REFERENCE=/\.(?:md|mdx|txt|yaml|yml|json|csv|tsv)$/iu;

function slug(value:string,fallback:string){
  return value.toLowerCase().replace(/[^a-z0-9]+/gu,'-').replace(/^-+|-+$/gu,'').slice(0,64)||fallback;
}
function splitSkill(source:string){
  const match=source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u);
  if(!match)return {metadata:{} as Record<string,unknown>,body:source.trim()};
  try{
    const parsed=parseYaml(match[1]!);
    return {metadata:parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{},body:source.slice(match[0].length).trim()};
  }catch{return {metadata:{},body:source.slice(match[0].length).trim()};}
}
function uniquePath(wanted:string,used:Set<string>,content:Uint8Array,files:Record<string,Uint8Array>){
  let candidate=wanted,index=2;
  const dot=wanted.lastIndexOf('.'),stem=dot>0?wanted.slice(0,dot):wanted,extension=dot>0?wanted.slice(dot):'';
  while(used.has(candidate.toLowerCase())){
    const existing=Object.entries(files).find(([name])=>name.toLowerCase()===candidate.toLowerCase());
    if(existing&&Buffer.compare(Buffer.from(existing[1]),Buffer.from(content))===0)return existing[0];
    candidate=`${stem}-migrated-${index++}${extension}`;
  }
  return candidate;
}
function replacePath(source:string,from:string,to:string){
  return source.replaceAll(`\`${from}\``,`\`${to}\``).replaceAll(`\`./${from}\``,`\`${to}\``)
    .replaceAll(`](${from})`,`](${to})`).replaceAll(`](./${from})`,`](${to})`);
}

/** Convert an arbitrary Skill subtree into the Agent Skills delivery layout. */
export function normalizeSkillPackage(archive:Record<string,Uint8Array>,skillFile:string,skillId:string,version:string){
  const root=skillFile.includes('/')?skillFile.slice(0,skillFile.lastIndexOf('/')):'';
  const prefix=root?`${root}/`:'';
  const scoped=Object.entries(archive).filter(([name])=>!root||name.startsWith(prefix));
  const output:Record<string,Uint8Array>={},used=new Set<string>(),moves:Array<{from:string;to:string}>=[];
  if(!archive[skillFile])throw Object.assign(new Error(`迁移输入缺少原始 Skill 指令：${skillFile}`),{statusCode:409});
  const originalSource=Buffer.from(archive[skillFile]!).toString('utf8');
  for(const [name,content] of scoped){
    if(name===skillFile)continue;
    const relative=root?name.slice(prefix.length):name;
    let wanted:string;
    if(/(^|\/)skill\.md$/iu.test(relative))wanted=`references/legacy-${relative.replaceAll('/','-')}`;
    else if(/^(?:scripts|references|assets)\//u.test(relative))wanted=relative;
    else if(SCRIPT.test(relative))wanted=`scripts/${relative}`;
    else if(REFERENCE.test(relative))wanted=`references/${relative}`;
    else wanted=`assets/${relative}`;
    wanted=uniquePath(wanted,used,content,output);
    if(!(wanted in output))output[wanted]=content;
    used.add(wanted.toLowerCase());
    if(wanted!==relative)moves.push({from:relative,to:wanted});
  }
  const {metadata,body}=splitSkill(originalSource);
  if(!body.trim())throw Object.assign(new Error('原始 Skill 正文为空，不能用通用模板替代业务流程'),{statusCode:409});
  const fallback=slug(skillId,'migrated-skill');
  metadata.name=slug(typeof metadata.name==='string'?metadata.name:skillId,fallback);
  metadata.version=version;
  const existingDescription=typeof metadata.description==='string'?metadata.description.trim():'';
  metadata.description=(existingDescription||`Migrated Skill ${metadata.name}. Review the instructions and use the packaged tools when applicable.`).slice(0,1024);
  let normalizedBody=body;
  for(const move of moves)normalizedBody=replacePath(normalizedBody,move.from,move.to);
  normalizedBody=normalizedBody.replace(/(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"'\n]+["']/giu,'credential must be supplied by the runtime environment');
  normalizedBody=normalizedBody.replace(/`((?:scripts|references|assets)\/[^`]+)`/gu,(whole,requested:string)=>{
    const exists=Object.keys(output).some(name=>name.toLowerCase()===requested.toLowerCase());
    return exists?whole:`${requested} (missing in source package; migration could not restore it)`;
  });
  const frontmatter=stringifyYaml(metadata,{lineWidth:0}).trimEnd();
  output['SKILL.md']=new TextEncoder().encode(`---\n${frontmatter}\n---\n\n${normalizedBody}\n`);
  return {files:output,moves};
}
