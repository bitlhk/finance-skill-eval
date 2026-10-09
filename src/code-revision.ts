import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// The server's own checkout, not the caller's cwd. Missing metadata remains unknown.
function readRevision() {
  try {
    const root=fileURLToPath(new URL('..',import.meta.url));
    const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8',timeout:2000,stdio:['ignore','pipe','ignore']}).trim();
    const commit=git('rev-parse','HEAD');
    if(!/^[a-f0-9]{40}$/.test(commit))return null;
    return {commit,workingTree:git('status','--porcelain')?'dirty' as const:'clean' as const,source:'server-checkout' as const};
  } catch {return null;}
}
export const codeRevision=readRevision();
