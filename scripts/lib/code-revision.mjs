import {execFileSync} from 'node:child_process';

// Optional build provenance, resolved before the HTTP service starts accepting
// work. Unavailable Git metadata must never block evaluation or task recovery.
export function codeRevision(root){
  try{
    const git=(...args)=>execFileSync('git',['-c','safe.directory='+root.replaceAll('\\','/'),'-C',root,...args],
      {encoding:'utf8',timeout:2000,windowsHide:true,stdio:['ignore','pipe','ignore']}).trim();
    const commit=git('rev-parse','HEAD');
    if(!/^[a-f0-9]{40}$/.test(commit))return null;
    return {commit,workingTree:git('status','--porcelain')?'dirty':'clean',source:'server-checkout'};
  }catch{return null;}
}
