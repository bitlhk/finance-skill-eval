import {parse} from 'yaml';

/** Read recognizable source metadata without rewriting source bytes. Candidates remain strict. */
export function sourceFrontmatter(content:string,sourceOnly=false):{name:string;description:string;warnings?:string[]}{
  const escapedDelimiter=sourceOnly&&content.startsWith('\\---');
  const header=(escapedDelimiter?content.slice(1):content).match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s|$)/)?.[1];
  if(!header)throw Object.assign(new Error('SKILL.md 缺少 YAML 头部'),{statusCode:400});
  try{
    const metadata=parse(header);
    if(typeof metadata?.name==='string'&&metadata.name.trim()&&typeof metadata.description==='string'&&metadata.description.trim())
      return {name:metadata.name.trim(),description:metadata.description,...(escapedDelimiter?{warnings:['源文件的头部分隔符被转义；原文件未修改，生成结果须修正。']}:{} )};
  }catch{/* Source recognition below is deliberately narrower than YAML recovery. */}
  if(sourceOnly){
    const normalized=header.replace(/\r/g,'');
    const names=[...normalized.matchAll(/^name:[ \t]*(.+)$/gm)];
    const descriptions=[...normalized.matchAll(/^description:[ \t]*$/gm)];
    if(names.length===1&&descriptions.length===1){
      let name:unknown;
      try{name=parse('name: '+names[0]![1]).name;}catch{/* Refuse ambiguous names. */}
      const rest=normalized.slice(descriptions[0]!.index!+descriptions[0]![0].length);
      const description=rest.split(/\n(?:license|metadata|compatibility|allowed-tools|version|name):/)[0]!.trim();
      if(typeof name==='string'&&name.trim()&&description&&!/^[-[\]{}]/.test(description))return {name:name.trim(),description,
        warnings:['源 SKILL.md 头部格式不合法；仅识别明确的名称和说明以便诊断，原文件未修改。生成结果须修正格式。']};
    }
  }
  throw Object.assign(new Error('SKILL.md 头部格式不合法，或缺少明确的 name/description'),{statusCode:400});
}
