/** A comparison-only view. Original asset bytes and hashes are never modified. */
export function normalizeSourceNewlines(text:string):string {return text.replace(/\r\n?/gu,'\n')}

/** Resolve a package-root or workspace-prefixed citation only when its suffix is unique. */
export function sourceEvidencePath(target:string,files:Readonly<Record<string,unknown>>):string|null{
  if(Object.prototype.hasOwnProperty.call(files,target))return target;
  const flat=target.replaceAll('\\','/').replace(/^[A-Za-z]:/u,'').replace(/^\.\//u,'');
  if(Object.prototype.hasOwnProperty.call(files,flat))return flat;
  const segments=flat.split('/').filter(Boolean);
  for(let index=0;index<segments.length;index++){
    const tail=segments.slice(index).join('/');
    const hits=Object.keys(files).filter(path=>path===tail||path.endsWith(`/${tail}`));
    if(hits.length===1)return hits[0]!;
    if(hits.length>1)return null;
  }
  return null;
}

/** Create once for each immutable source snapshot; normalized files are cached lazily. */
export class SourceEvidenceValidator {
 private readonly files:Readonly<Record<string,string>>;
 private readonly cache=new Map<string,string>();
 constructor(files:Readonly<Record<string,string>>){this.files={...files}}
 text(filePath:string):string|undefined {
  const source=this.files[filePath];if(source===undefined)return undefined;
  let text=this.cache.get(filePath);if(text===undefined){text=normalizeSourceNewlines(source);this.cache.set(filePath,text)}
  return text;
 }
 find(filePath:string,snippet:string):{path:string;line:number;offset:number}|null {
  const text=this.text(filePath);if(text===undefined||!snippet)return null;
  const offset=text.indexOf(normalizeSourceNewlines(snippet));if(offset<0)return null;
  return {path:filePath,line:text.slice(0,offset).split('\n').length,offset};
 }
 containsAtLines(filePath:string,snippet:string,line:number,endLine:number):boolean {
  const text=this.text(filePath);if(text===undefined||!snippet)return false;
  const lines=text.split('\n');if(!Number.isInteger(line)||!Number.isInteger(endLine)||line<1||endLine<line||endLine>lines.length)return false;
  return lines.slice(line-1,endLine).join('\n').includes(normalizeSourceNewlines(snippet));
 }
}
