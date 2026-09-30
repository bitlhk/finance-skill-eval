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

function imports(source:string){
  return [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu)].map(match=>match[1]!);
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
});
