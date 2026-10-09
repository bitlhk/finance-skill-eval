import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {zipSync} from 'fflate';
import {SkillStore} from '../dist/service/skill-store.js';
import {fingerprint} from '../dist/contracts.js';
import {loadEvalPack} from '../dist/eval-pack.js';

export async function installNativeSample(dataDirectory){
  const root=fileURLToPath(new URL('../',import.meta.url));
  const source=await readFile(path.join(root,'examples/native-readonly-balance/SKILL.md'));
  const digest=fingerprint([{name:'SKILL.md',content:source.toString('base64')}]);
  const pack=await loadEvalPack(path.join(root,'packs/finance/native-readonly-balance/eval.yaml'));
  if(pack.variants.right.artifactSha256!==digest)throw Error('PREBUILT_SAMPLE_DIGEST_MISMATCH');
  const store=new SkillStore(path.resolve(dataDirectory));await store.initialize();
  const asset=await store.uploadZip(Buffer.from(zipSync({'SKILL.md':source})));
  if(asset.skillId!==pack.targetSkillId||asset.version!==pack.targetSkillVersion)throw Error('PREBUILT_SAMPLE_VERSION_MISMATCH');
  return asset;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3)throw Error('Usage: node scripts/install-native-sample.mjs PRIVATE_STATE_DIRECTORY');
  console.log(JSON.stringify(await installNativeSample(process.argv[2])));
}
