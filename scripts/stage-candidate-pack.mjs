import { readFile } from 'node:fs/promises';
import { stageCandidatePack } from '../dist/service/candidate-pack-staging.js';

if (process.argv.length !== 3) throw Error('Usage: node scripts/stage-candidate-pack.mjs OPERATOR_MANIFEST.json');
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const report = await stageCandidatePack({ ...input, archive: await readFile(input.archiveFile) });
console.log(JSON.stringify({ status: report.status, packId: report.packId,
  skillId: report.asset.skillId, version: report.asset.version, artifactSha256: report.asset.artifactSha256 }));
