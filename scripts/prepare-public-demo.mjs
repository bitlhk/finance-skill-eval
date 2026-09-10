import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse } from 'yaml';
import { SkillStore } from '../dist/service/skill-store.js';

// An isolated, curated demo workspace. Never copy arbitrary uploads or old jobs.
const root=path.resolve('.public-demo'), data=path.join(root,'data');
await mkdir(`${root}/packs/finance`,{recursive:true});
await cp('packs/finance/catalog.yaml',`${root}/packs/finance/catalog.yaml`);
const source=new SkillStore(path.resolve('data')), target=new SkillStore(data);
await target.initialize(); const assets=await source.list();
for(const entry of await readdir('packs/finance',{withFileTypes:true})) {
  if(!entry.isDirectory()||!entry.name.endsWith('-online')) continue;
  const directory=`packs/finance/${entry.name}`, pack=parse(await readFile(`${directory}/eval.yaml`,'utf8'));
  const asset=assets.find(a=>a.skillId===pack.targetSkillId&&a.version===pack.targetSkillVersion&&a.artifactSha256===pack.variants.right.artifactSha256);
  if(!asset) throw new Error(`Missing asset for ${pack.packId}`);
  const {zipSync,strToU8}=await import('fflate');
  const files=await source.readFiles(asset.assetId);
  await target.uploadZip(Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name,content])=>[name,strToU8(content)])))));
  await cp(directory,`${root}/${directory}`,{recursive:true});
}
await cp('data/environments',`${data}/environments`,{recursive:true});
const token=await readFile(`${root}/ingress.token`,'utf8').catch(e=>{if(e.code==='ENOENT')return randomBytes(32).toString('hex');throw e;});
await writeFile(`${root}/ingress.token`,token,{mode:0o600});
await writeFile(`${root}/service.env`,[
  `FINANCE_EVAL_ROOT=${root}`,`FINANCE_EVAL_DATA_DIR=${data}`,`FINANCE_EVAL_PUBLIC_DIR=${path.resolve('web-dist')}`,
  'FINANCE_EVAL_HOST=127.0.0.1','FINANCE_EVAL_PORT=56371','FINANCE_EVAL_PUBLIC_DEMO=true',
  'FINANCE_EVAL_PUBLIC_ORIGIN=https://finance-eval.demo.linggan.top',`FINANCE_EVAL_ACCESS_TOKEN=${token}`,
].join('\n')+'\n',{mode:0o600});
console.log('Prepared isolated curated public demo. Ingress token remains server-side.');
