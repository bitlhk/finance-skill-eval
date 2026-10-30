import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

/** Export only committed Builder workspace bytes, never private configuration.
 * The child must not import from a checkout another developer can switch.
 */
export async function pinnedBuilderSource({project,commit,destination}) {
  const git=(...args)=>execFileSync('git',args,{cwd:project,encoding:'utf8',windowsHide:true}).trim();
  assert(/^[a-f0-9]{40}$/.test(commit),'A full Builder commit is required');
  const repository=git('rev-parse','--show-toplevel');
  const workspace=path.dirname(project);
  const relative=path.relative(repository,workspace).replaceAll('\\','/');
  assert(relative&&!relative.startsWith('../')&&!path.isAbsolute(relative),'Builder workspace must be inside its repository');
  const archive=path.join(destination,'builder-source.tar');
  const exported=path.join(destination,'source');
  await mkdir(exported,{recursive:false});
  // git archive applies checkout conversions too. Pin LF so Windows autocrlf
  // cannot change the raw source identity consumed on a Linux Builder host.
  git('-c','core.autocrlf=false','-C',repository,'archive','--format=tar',`--output=${archive}`,commit,'--',relative);
  execFileSync('tar',['-xf',archive,'-C',exported],{windowsHide:true,stdio:'pipe'});
  return path.join(exported,relative,path.basename(project));
}
