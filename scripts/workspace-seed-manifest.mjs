import {createHash} from 'node:crypto';
import {lstat,readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {readWorkspaceSeed} from '../dist/service/account-workspaces.js';

const directory=process.argv[2];
if(!directory)throw new Error('Usage: node scripts/workspace-seed-manifest.mjs DIRECTORY');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const entries=[];
let bytes=0;
async function walk(relative){
  const target=path.join(directory,relative),stat=await lstat(target);
  if(stat.isSymbolicLink())throw new Error('WORKSPACE_SEED_SYMLINK');
  if(stat.isDirectory())for(const name of (await readdir(target)).sort()){
    if(!relative&&!['skills','environments','preparations'].includes(name))throw new Error('WORKSPACE_SEED_CONTENT_NOT_ALLOWED');
    await walk(path.posix.join(relative,name));
  }
  else if(stat.isFile()){
    bytes+=stat.size;
    if(stat.size>8*1024*1024||bytes>32*1024*1024||entries.length>=2000)throw new Error('WORKSPACE_SEED_TOO_LARGE');
    entries.push({path:relative,sha256:hash(await readFile(target))});
  }
  else throw new Error('WORKSPACE_SEED_FILE_INVALID');
}
await walk('');
const sha256=hash(JSON.stringify(entries));
await readWorkspaceSeed(directory,sha256);
console.log(JSON.stringify({schemaVersion:'finance.account-seed.v1',sha256,files:entries},null,2));
