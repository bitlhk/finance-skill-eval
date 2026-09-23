import {builtinModules} from 'node:module';
import type {DependencyLibrary,RuntimeLibraryInventory} from '../migration/domain/migration-dependency.js';

export type {DependencyLibrary,RuntimeLibraryInventory} from '../migration/domain/migration-dependency.js';
const nodeModules=new Set(builtinModules.map(name=>name.replace(/^node:/u,'')));
const canonical=(name:string)=>name.toLowerCase().replace(/[-_.]+/gu,'-');

/** Validate model classifications using import citations and inert package metadata. Never import customer code. */
export function verifyDependencyLibrary(claim:DependencyLibrary|undefined,evidence:Array<{path:string;snippet:string}>,files:Record<string,string>,inventory?:RuntimeLibraryInventory):DependencyLibrary|undefined {
 if(!claim)return undefined;
 const module=claim.module,root=module.split('.')[0]!;
 const escaped=module.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
 const imports=claim.language==='python'?new RegExp(`^\\s*(?:from\\s+${escaped}(?:\\.[\\w.]+)?\\s+import\\b|import\\s+${escaped}(?=[\\s,;. ]|$))`,'mu'):new RegExp(`(?:from\\s*|require\\s*\\(\\s*|import\\s*(?:\\(\\s*)?)['"]${escaped}['"]`,'u');
 if(!evidence.some(item=>(claim.language==='python'?/\.py$/iu:/\.(?:[cm]?js|tsx?)$/iu).test(item.path)&&imports.test(item.snippet)))return {...claim,type:'UNKNOWN',verified:false};
 if(claim.type==='STANDARD_LIBRARY'){
  const shadowed=claim.language==='python'&&Object.keys(files).some(file=>file.endsWith(`/${root}.py`)||file===`${root}.py`||file.includes(`/${root}/__init__.py`)||file===`${root}/__init__.py`);
  const known=claim.language==='python'?!!inventory?.python.standardModules.includes(root)&&!shadowed:nodeModules.has(module.replace(/^node:/u,''));
  return {...claim,type:known?'STANDARD_LIBRARY':'UNKNOWN',verified:known,...(known?{environmentVersion:claim.language==='python'?inventory!.python.version:process.versions.node}:{})};
 }
 if(claim.type==='PACKAGE'&&claim.packageName){
  const nodeRoot=module.startsWith('@')?module.split('/').slice(0,2).join('/'):module.split('/')[0]!;
  const matches=claim.language==='node'?nodeRoot===claim.packageName:canonical(root)===canonical(claim.packageName)||(inventory?.python.packageDistributions?.[root]??[]).some(name=>canonical(name)===canonical(claim.packageName!));
  if(!matches)return {...claim,verified:false};
  const paths=(claim.declarationPaths??[]).filter(file=>Object.hasOwn(files,file)&&evidence.some(item=>item.path===file));
  for(const file of paths){
   const source=files[file]!;
   if(claim.language==='node'&&/(?:^|\/)package\.json$/u.test(file)){
    try{const value=JSON.parse(source);for(const key of ['dependencies','optionalDependencies','peerDependencies'])if(typeof value[key]?.[claim.packageName]==='string')return {...claim,verified:true,version:value[key][claim.packageName],declarationPaths:[file]};}catch{}
   }
   if(claim.language==='python'&&(/(?:^|\/)(?:pyproject\.toml|requirements[^/]*\.txt)$/u.test(file)||/\.py$/u.test(file)&&/^#\s*\/\/\/\s*script\s*$/mu.test(source))){
    let text=/\.py$/u.test(file)?(source.split(/^#\s*\/\/\/\s*script\s*$/mu)[1]?.split(/^#\s*\/\/\/\s*$/mu)[0]??'').replace(/^# ?/gmu,''):source;
    if(/pyproject\.toml$/u.test(file))text=text.split(/^\s*\[project\]\s*$/mu)[1]?.split(/^\s*\[[^\]]+\]/mu)[0]??'';
    const declarations=/^\s*dependencies\s*=\s*\[((?:[^\]"']|"[^"]*"|'[^']*')*)\]/mu.exec(text)?.[1]??'';
    const specs=/(?:^|\/)requirements[^/]*\.txt$/u.test(file)?text.split(/\r?\n/gu):[...declarations.matchAll(/["']([^"'\n]+)["']/gu)].map(match=>match[1]!);
    for(const spec of specs){const match=/^([\w.-]+)(?:\[[\w,.-]+\])?\s*(.*)$/u.exec(spec.trim());if(match&&canonical(match[1]!)===canonical(claim.packageName))return {...claim,verified:true,version:match[2]!.trim(),declarationPaths:[file]};}
   }
  }
  return {...claim,verified:false};
 }
 return {...claim,verified:false};
}
