import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
const root=process.cwd();
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):/\.(?:tsx?|mjs)$/.test(e.name)?[path.join(dir,e.name)]:[]);}
const files=['web/src','tests','scripts','examples'].flatMap(d=>fs.existsSync(d)?walk(path.resolve(d)):[]);
const edges=new Map();
for(const file of files){
 const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true),imports=[];
 function visit(n){
  if(ts.isStringLiteral(n)&&n.text.startsWith('.')&&(ts.isImportDeclaration(n.parent)||ts.isExportDeclaration(n.parent)||ts.isLiteralTypeNode(n.parent)||ts.isCallExpression(n.parent))) {
   const p=path.resolve(path.dirname(file),n.text),options=[p,p.replace(/\.js$/,'.ts'),p.replace(/\.js$/,'.tsx'),p+'.ts',p+'.tsx',path.join(p,'index.ts')];
   const target=options.find(x=>fs.existsSync(x)&&fs.statSync(x).isFile());if(target)imports.push(target);
  }
  ts.forEachChild(n,visit);
 }visit(ast);edges.set(file,imports);
}
// Include process-spawn and documented CLI entries that do not use static imports.
const roots=['web/src/main.tsx','scripts/serve-api.mjs','scripts/run-cli.mjs','scripts/runtime-check.mjs'].map(f=>path.join(root,f));
const used=new Set();function mark(f){if(used.has(f))return;used.add(f);for(const e of edges.get(f)??[])mark(e);}roots.forEach(mark);
const relative=f=>path.relative(root,f).replaceAll('\\','/');
const dead=files.filter(f=>!used.has(f)&&relative(f).startsWith('src/')).map(relative);
const consumers=Object.fromEntries(dead.map(f=>[f,[...edges].filter(([,deps])=>deps.includes(path.join(root,f))).map(([x])=>relative(x))]));
console.log(JSON.stringify({dead,consumers,unusedWeb:files.filter(f=>relative(f).startsWith('web/src/')&&!used.has(f)).map(relative),used:[...used].map(relative)},null,2));
