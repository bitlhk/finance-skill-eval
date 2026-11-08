// One-time data migration. No application routes or model execution live here.
import {createHash} from 'node:crypto';
import {lstat,readdir,readFile,mkdir,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function exportLegacyAssetOrders(dataDirectory,seedDirectory){
  const root=path.resolve(dataDirectory),assets={};let verified=0,invalid=0;
  const index=path.join(root,'native-asset-orders.json');
  try{
    const saved=JSON.parse(await readFile(index,'utf8'));
    if(saved.schemaVersion!=='finance.asset-import-order.v1')throw new Error('Unexpected asset import metadata');
    Object.assign(assets,saved.assets??{});
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const roots=[root,...(seedDirectory?[path.resolve(seedDirectory)]:[])];
  try{
    const accounts=path.join(root,'account-workspaces');
    if((await lstat(accounts)).isSymbolicLink())throw new Error('Unsafe account workspace directory');
    for(const name of await readdir(accounts))if(/^[a-f0-9]{64}$/.test(name))roots.push(path.join(accounts,name));
  }catch(error){if(error.code!=='ENOENT')throw error;}
  for(const directory of roots){
    if((await lstat(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))?.isSymbolicLink())throw new Error('Unsafe workspace directory');
    const records=path.join(directory,'skills','records');
    const names=await readdir(records).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    for(const name of names.filter(name=>name.endsWith('.json'))){
      try{
        const record=JSON.parse(await readFile(path.join(records,name),'utf8'));
        if(!/^[a-z0-9-]+$/.test(record.assetId)||!/^[a-f0-9]{64}$/.test(record.artifactSha256))throw new Error('Invalid asset identity');
        const files=new Map(),base=path.join(directory,'skills','assets',record.assetId);
        async function walk(relative){
          const target=path.join(base,relative),stat=await lstat(target);
          if(stat.isSymbolicLink())throw new Error('Asset contains a link');
          if(stat.isDirectory())for(const name of await readdir(target))await walk(path.posix.join(relative,name));
          else if(stat.isFile())files.set(relative,await readFile(target));
          else throw new Error('Invalid asset file');
        }
        await walk('');
        const order=[...files.keys()].sort((a,b)=>a.localeCompare(b));
        if(files.size!==record.fileCount||sha(JSON.stringify(order.map(name=>({content:files.get(name).toString('base64'),name}))))!==record.artifactSha256)throw new Error('Asset digest mismatch');
        const hash=createHash('sha256');
        for(const name of [...files.keys()].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))))hash.update(name).update('\0').update(files.get(name)).update('\0');
        assets[record.artifactSha256]={order,filesDigest:hash.digest('hex')};verified++;
      }catch{invalid++;}
    }
  }
  await mkdir(root,{recursive:true});
  const temporary=index+'.'+process.pid+'.tmp';
  await writeFile(temporary,JSON.stringify({schemaVersion:'finance.asset-import-order.v1',assets}),{mode:0o600});
  await rename(temporary,index);
  return {verified,invalid};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const result=await exportLegacyAssetOrders(process.env.FINANCE_EVAL_DATA_DIR||path.resolve('data'),process.env.FINANCE_EVAL_WORKSPACE_SEED_DIRECTORY);
  process.stdout.write(JSON.stringify(result)+'\n');
}
