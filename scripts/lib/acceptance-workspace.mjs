import {mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';

/** Real manual acceptance evidence survives OS temporary-directory cleanup. */
export async function createAcceptanceWorkspace(prefix,root=process.cwd()){
  if(!/^[a-z0-9-]+-$/u.test(prefix))throw new Error('Invalid acceptance workspace prefix');
  const base=path.resolve(root,'.migration-workspace','acceptance');
  await mkdir(base,{recursive:true});
  return mkdtemp(path.join(base,prefix));
}
