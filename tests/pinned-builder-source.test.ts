import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error Private acceptance orchestration is outside the production bundle.
import {pinnedBuilderSource} from '../scripts/lib/pinned-builder-source.mjs';

it('runs committed workspace sources even after the original checkout changes, without private/untracked files',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'pinned-builder-test-'));
  const repository=path.join(root,'repository'),workspace=path.join(repository,'community/builder');
  const project=path.join(workspace,'solution');
  await mkdir(project,{recursive:true});await mkdir(path.join(workspace,'base'));
  const git=(...args:string[])=>execFileSync('git',args,{cwd:repository,encoding:'utf8',windowsHide:true}).trim();
  git('init');
  await writeFile(path.join(project,'worker.py'),'committed worker');
  await writeFile(path.join(workspace,'base/runtime.py'),'committed base');
  git('add','.');git('-c','user.name=Acceptance','-c','user.email=acceptance@example.invalid','commit','-m','fixture');
  const commit=git('rev-parse','HEAD');
  await writeFile(path.join(project,'.env'),'private-secret');
  await writeFile(path.join(project,'worker.py'),'different branch worker');
  const frozen=await pinnedBuilderSource({project,commit,destination:root});
  await writeFile(path.join(project,'worker.py'),'changed again');
  expect(await readFile(path.join(frozen,'worker.py'),'utf8')).toBe('committed worker');
  expect(await readFile(path.join(frozen,'../base/runtime.py'),'utf8')).toBe('committed base');
  await expect(readFile(path.join(frozen,'.env'))).rejects.toMatchObject({code:'ENOENT'});
  await expect(pinnedBuilderSource({project,commit:'HEAD',destination:root})).rejects.toThrow('full Builder commit');
});

it('exports committed raw Builder bytes even when the caller uses Windows autocrlf', async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'builder-source-'));
  const repository=path.join(root,'repository');
  const project=path.join(repository,'community','builder','finance-solution-builder');
  const destination=path.join(root,'export');
  await mkdir(project,{recursive:true});
  await mkdir(destination);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:repository,encoding:'utf8',windowsHide:true}).trim();
  try{
    git('init','-q');
    git('config','core.autocrlf','true');
    const raw=Buffer.from('approved case\nsecond line\n');
    const binary=Buffer.from([0,13,10,255]);
    await writeFile(path.join(project,'case.json'),raw);
    await writeFile(path.join(project,'data.bin'),binary);
    git('add','.');
    git('-c','user.name=Regression','-c','user.email=regression@example.invalid','commit','-qm','Frozen source');
    const commit=git('rev-parse','HEAD');
    await writeFile(path.join(project,'case.json'),'uncommitted change\r\n');
    await writeFile(path.join(project,'.env'),'PRIVATE_UNTRACKED_VALUE');
    const exported=await pinnedBuilderSource({project,commit,destination});
    expect(await readFile(path.join(exported,'case.json'))).toEqual(raw);
    expect(await readFile(path.join(exported,'data.bin'))).toEqual(binary);
    await expect(readFile(path.join(exported,'.env'))).rejects.toMatchObject({code:'ENOENT'});
    expect(git('config','core.autocrlf')).toBe('true');
  }finally{
    await rm(root,{recursive:true,force:true});
  }
});
