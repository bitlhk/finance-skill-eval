/** Read-only audit of recorded real A2 output against current dependency graph schema and source ZIP. */
import {readFile,readdir,writeFile} from 'node:fs/promises';import path from 'node:path';import {z} from 'zod';import {unzipSync} from 'fflate';
const root=process.cwd(),record=path.resolve(process.argv[2]);
const moduleText=await readFile(path.join(root,'src/service/migration-dependencies.ts'),'utf8');
const schemaText=moduleText.slice(moduleText.indexOf('const citation='),moduleText.indexOf('export const dependencyId='));
// This evaluates the local module's exact schema declarations, not Agent-produced code.
const schema=new Function('z',schemaText+'\nreturn graphSchema;')(z);
const outcomes=[];
for(const name of ['01-expense','02-balance','03-procurement','04-refund']){
 const dir=path.join(record,name);let names;try{names=(await readdir(dir)).filter(n=>/^a2-\d+\.json$/u.test(n)).sort()}catch{continue}if(!names.length)continue;
 const a2=JSON.parse(await readFile(path.join(dir,names[0]),'utf8'));const graph=a2.payload?.dependencyAnalysis;if(!graph){outcomes.push({name,agentStatus:a2.status,error:a2.reason??'No dependency analysis output'});continue}
 const bytes=unzipSync(await readFile(path.join(root,'acceptance/enterprise-migration-examples',name,'source.zip')));const files=Object.fromEntries(Object.entries(bytes).map(([p,b])=>[p,Buffer.from(b).toString('utf8')]));
 const parsed=schema.safeParse(graph);const issues=parsed.success?[]:parsed.error.issues.map(i=>({path:i.path,message:i.message}));const citationChecks={valid:0,newlineMismatch:0,otherMismatch:0,missingPath:0};
 function walk(x){if(!x||typeof x!=='object')return;if(typeof x.path==='string'&&typeof x.snippet==='string'){const p=x.path.replaceAll('\\','/');const matches=Object.keys(files).filter(k=>p===k||p.endsWith('/'+k));if(matches.length!==1)citationChecks.missingPath++;else{const text=files[matches[0]],s=x.snippet;if(text.includes(s))citationChecks.valid++;else if(text.replaceAll('\r\n','\n').includes(s.replaceAll('\r\n','\n')))citationChecks.newlineMismatch++;else citationChecks.otherMismatch++}}for(const v of Object.values(x))walk(v)}walk(graph);
 const resolvedPathMismatches=graph.dependencies.flatMap(d=>(d.resolvedPaths??[]).filter(p=>files[p]===undefined).map(p=>({key:d.key,path:p,matchingSourcePath:Object.keys(files).find(k=>p.replaceAll('\\','/').endsWith('/'+k))??null})));
 outcomes.push({name,agentStatus:a2.status,graphSchemaIssues:issues,citationChecks,resolvedPathMismatches});
}
const result={record,outcomes};await writeFile(path.join(record,'diagnosis-audit.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
