import {readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';

const migrationRoot=fileURLToPath(new URL('../src/migration/',import.meta.url));

function sourceFiles(layer:'application'|'domain'){
  const directory=path.join(migrationRoot,layer);
  return readdirSync(directory,{withFileTypes:true})
    .filter(entry=>entry.isFile()&&entry.name.endsWith('.ts'))
    .map(entry=>path.join(directory,entry.name));
}

function migrationSourceFiles(directory=migrationRoot):string[]{
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const absolute=path.join(directory,entry.name);
    if(entry.isDirectory())return migrationSourceFiles(absolute);
    return entry.isFile()&&entry.name.endsWith('.ts')?[absolute]:[];
  });
}

function imports(source:string){
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*)['"]([^'"]+)['"]/gu)].map(match=>match[1]!);
}

function resolvedMigrationImport(file:string,specifier:string,known:ReadonlySet<string>):string|null{
  if(!specifier.startsWith('.'))return null;
  const raw=path.resolve(path.dirname(file),specifier);
  const candidates=raw.endsWith('.js')?[`${raw.slice(0,-3)}.ts`]:path.extname(raw)?[raw]:[`${raw}.ts`,path.join(raw,'index.ts')];
  return candidates.find(candidate=>known.has(candidate))??null;
}

function dependencyCycles(graph:ReadonlyMap<string,readonly string[]>):string[][]{
  const state=new Map<string,'visiting'|'visited'>(),stack:string[]=[],cycles:string[][]=[];
  const visit=(file:string)=>{
    if(state.get(file)==='visiting'){
      const start=stack.indexOf(file);
      if(start>=0)cycles.push([...stack.slice(start),file]);
      return;
    }
    if(state.get(file)==='visited')return;
    state.set(file,'visiting');stack.push(file);
    for(const dependency of graph.get(file)??[])visit(dependency);
    stack.pop();state.set(file,'visited');
  };
  for(const file of graph.keys())visit(file);
  return cycles;
}

describe('migration architecture boundaries',()=>{
  it('keeps the public store facade free of infrastructure and platform service construction',()=>{
    const file=path.join(migrationRoot,'migration-store.ts');
    const violations=imports(readFileSync(file,'utf8'))
      .filter(specifier=>specifier.includes('/infrastructure/')||specifier.startsWith('./infrastructure/')
        ||specifier.includes('/service/')||specifier.startsWith('../service/'));
    expect(violations).toEqual([]);
  });

  it('keeps application workflows independent of infrastructure and service implementations',()=>{
    const violations=sourceFiles('application').flatMap(file=>imports(readFileSync(file,'utf8'))
      .filter(specifier=>specifier.includes('/infrastructure/')||specifier.startsWith('../infrastructure/')||specifier.includes('/service/')||specifier.startsWith('../../service/'))
      .map(specifier=>`${path.basename(file)} -> ${specifier}`));
    expect(violations).toEqual([]);
  });

  it('keeps the domain independent of application, infrastructure and service layers',()=>{
    const violations=sourceFiles('domain').flatMap(file=>imports(readFileSync(file,'utf8'))
      .filter(specifier=>specifier.includes('/application/')||specifier.startsWith('../application/')
        ||specifier.includes('/infrastructure/')||specifier.startsWith('../infrastructure/')
        ||specifier.includes('/service/')||specifier.startsWith('../../service/'))
      .map(specifier=>`${path.basename(file)} -> ${specifier}`));
    expect(violations).toEqual([]);
  });

  it('keeps the migration module free of static import cycles',()=>{
    const files=migrationSourceFiles(),known=new Set(files);
    const graph=new Map(files.map(file=>[file,imports(readFileSync(file,'utf8'))
      .map(specifier=>resolvedMigrationImport(file,specifier,known))
      .filter((dependency):dependency is string=>dependency!==null)]));
    const cycles=dependencyCycles(graph).map(cycle=>cycle.map(file=>path.relative(migrationRoot,file)).join(' -> '));
    expect(cycles,'Migration import cycles').toEqual([]);
  });

  it('reports the complete path when an import graph contains a cycle',()=>{
    expect(dependencyCycles(new Map([['a',['b']],['b',['c']],['c',['a']]]))).toEqual([['a','b','c','a']]);
  });
});
