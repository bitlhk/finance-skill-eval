import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageCandidatePack } from '../dist/service/candidate-pack-staging.js';

if (process.argv.length < 5) throw Error('Usage: node scripts/verify-curated-candidate-staging.mjs PROBE_ROOT NEW_OUTPUT SKILL_ID...');
const [probeRoot, output, ...ids] = process.argv.slice(2);
if (ids.some(id => !/^[a-z0-9-]+$/u.test(id)) || new Set(ids).size !== ids.length) throw Error('Explicit unique Skill IDs required');
const repository = fileURLToPath(new URL('../', import.meta.url));
await mkdir(output, { mode: 0o700 });
const results = [];
for (const id of ids) {
  const skill = JSON.parse(await readFile(path.join(probeRoot, id, 'skill.json'), 'utf8'));
  const adaptation = JSON.parse(await readFile(path.join(probeRoot, id, 'adaptation.json'), 'utf8'));
  results.push(await stageCandidatePack({ sourcePack: path.join(repository, 'packs/finance', `${id}-online`, 'eval.yaml'),
    archive: Buffer.from(skill.archiveBase64, 'base64'), archiveSha256: skill.archiveSha256,
    skillId: id, skillVersion: skill.version, packId: `${id}-native-candidate-v1`, packVersion: '1.0.0',
    toolMapping: adaptation.toolNameMapping, outputDirectory: path.join(output, id) }));
}
await writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'PREPARED_NOT_ACCEPTED', results,
  productionChanged: false, runtimeAdmission: 'NOT_RUN', liveModel: 'NOT_RUN',
  limitations: ['Separate staging stores, not an installed release', 'Customer references and prompts unchanged; source bindings need separate verification',
    'Preserved source model settings are not evidence of equal actual runtime parameters', 'No professional quality or full catalog coverage claim'] }, null, 2));
console.log(JSON.stringify({ status: 'PREPARED_NOT_ACCEPTED', skills: results.map(r => r.asset.skillId), output }));
