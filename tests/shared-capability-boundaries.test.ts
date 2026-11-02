import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {expect,it} from 'vitest';

function files(root:string):string[]{
  return readdirSync(root,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(root,entry.name)):
    entry.name.endsWith('.ts')?[path.join(root,entry.name)]:[]);
}
it('cannot reintroduce the retired migration orchestrators or process entries',()=>{
  for(const name of ['src/migration/migration-store.ts','src/migration/migration-composition.ts',
    'src/interfaces/http/migration-routes.ts','src/migration/application/migration-improvement-task-service.ts',
    'src/migration/infrastructure/migration-project-repository.ts','src/migration/application/migration-project-store.ts',
    'integrations/openjiuwen/analyze_agent.py','integrations/openjiuwen/migrate_agent.py'])
    expect(existsSync(fileURLToPath(new URL('../'+name,import.meta.url))),name).toBe(false);
  const server=readFileSync(fileURLToPath(new URL('../src/service/server.ts',import.meta.url)),'utf8');
  expect(server).not.toContain('MigrationStore');
  expect(server).toContain('createHistoricalServiceEnvironmentResolver');
  expect(server).toContain('createMigrationTaskService');
});
it('routes all optimization adapters and engineering agents through their shared executors',()=>{
  const read=(name:string)=>readFileSync(fileURLToPath(new URL('../'+name,import.meta.url)),'utf8');
  for(const file of ['src/improvement/application/optimization-loop.ts']){
    const source=read(file);
    expect(source).toContain('runRoundWorkflow');
    expect(source).not.toMatch(/for\s*\([^)]*(?:round|iteration)\s*=/u);
  }
  for(const name of ['bundle_agent']){
    const source=read(`integrations/openjiuwen/${name}.py`);
    expect(source).toContain('assemble_agent');
    expect(source).not.toMatch(/init_model\(|create_(?:explore|code|deep)_agent\(|SYSTEM_PROMPT\s*=/u);
    expect(source).not.toContain('skill_rail');
  }
});
it('keeps shared Agent, evaluation and improvement capabilities independent of migration and service composition',()=>{
  const root=fileURLToPath(new URL('../src/',import.meta.url));
  const violations=['agents','evaluation','improvement'].flatMap(directory=>files(path.join(root,directory))).flatMap(file=>{
    const source=readFileSync(file,'utf8');
    const imports=[...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(?)["']([^"']+)["']/gu)].map(match=>match[1]!);
    return imports.filter(specifier=>/\/(?:migration|service|interfaces)\//u.test(specifier)
      ||(file.includes(path.sep+'domain'+path.sep)&&/\/(?:application|agents|infrastructure)\//u.test(specifier)))
      .map(specifier=>`${path.relative(root,file)} -> ${specifier}`);
  });
  expect(violations).toEqual([]);
});
