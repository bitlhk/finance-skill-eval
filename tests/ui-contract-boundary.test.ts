import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';

async function sources(directory:string):Promise<string[]>{
  const entries=await readdir(directory,{withFileTypes:true});
  return (await Promise.all(entries.map(entry=>entry.isDirectory()?sources(path.join(directory,entry.name)):[path.join(directory,entry.name)]))).flat();
}
it('browser modules consume public contracts without importing backend implementations',async()=>{
  const violations:string[]=[];
  for(const file of await sources('web/src')){
    if(!/\.tsx?$/.test(file))continue;
    const content=await readFile(file,'utf8');
    if(/(?:from\s*|import\s*\()\s*['"][^'"]*\.\.\/src\//.test(content))violations.push(file);
  }
  expect(violations).toEqual([]);
  const contract=await readFile('contracts/platform/responses.d.ts','utf8');
  expect(contract).not.toMatch(/\bimport\(|node:|AbortSignal|ModelAdapter/);
});
