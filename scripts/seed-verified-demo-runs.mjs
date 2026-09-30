import {readFile,cp} from 'node:fs/promises';
const ids=process.argv.slice(2);
if(!ids.length)throw new Error('Provide the exact completed synthetic run IDs to publish');
for(const id of ids){
  if(!/^run-[a-f0-9-]+$/.test(id))throw new Error('Invalid run ID');
  const source=`data/runs/${id}.json`,j=JSON.parse(await readFile(source,'utf8'));
  if(j.status!=='completed'||j.configuration.runtime.type!=='runtime_launcher'||!j.report?.cases.every(c=>c.left.status==='completed'&&c.right.status==='completed'&&c.judge&&c.right.metadata?.dataMode?.includes('synthetic')))throw new Error(`Run ${id} is not verified synthetic evidence`);
  await cp(source,`.public-demo/data/runs/${id}.json`,{errorOnExist:true,force:false});
  console.log(`${id}: copied original timestamps, configuration and report fingerprint unchanged`);
}
