import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EvalPackCatalog } from '../dist/service/catalog.js';
import { OpenAiCompatibleModelAdapter } from '../dist/openai-compatible-model.js';
import { SkillStore } from '../dist/service/skill-store.js';
import { generateRunQuestions } from '../dist/service/run-questions.js';

const skillId = process.argv[2] ?? 'goldencoach-stage-evaluation';
const catalog = new EvalPackCatalog(process.cwd()); await catalog.initialize();
const selected = catalog.list().find(p => p.targetSkillId === skillId && !p.replayReady);
const pack = selected ? catalog.get(selected.packId) : null;
if (!pack) throw new Error('Missing online Eval Pack');
const store = new SkillStore('data');
const asset = (await store.list()).find(a => a.skillId === skillId && a.artifactSha256 === pack.variants.right.artifactSha256);
if (!asset) throw new Error('Missing pinned Skill');
const connection = JSON.parse(await readFile('.runtime.local.json', 'utf8')).models['glm-5.2'];
const adapter = new OpenAiCompatibleModelAdapter({ apiKey: connection.apiKey, baseUrl: connection.baseUrl, requestDefaults: { ...connection.extraBody, max_tokens: 6000, temperature: 0.7 } });
const skill = { instructions: await store.readSource(asset.assetId), files: await store.readFiles(asset.assetId), artifactSha256: asset.artifactSha256 };
const batches = [];
for (let i = 0; i < 2; i++) {
  const batch = await generateRunQuestions({ pack, skill, model: { providerId: 'service-analyzer', modelId: 'glm-5.2', parameters: {} }, adapter, count: 3, generationId: randomUUID(), signal: AbortSignal.timeout(120000) });
  batches.push(batch);
  console.log(JSON.stringify({ batch: i + 1, fingerprint: batch.fingerprint, questions: batch.cases.map(c => ({ name: c.name, prompt: c.prompt, tools: c.requiredTools })) }));
}
const normalize = s => s.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '');
const old = new Set(pack.cases.map(c => normalize(c.prompt)));
if (batches.some(b => b.cases.some(c => old.has(normalize(c.prompt))))) throw new Error('Copied regression question');
if (batches[0].fingerprint === batches[1].fingerprint || batches[1].cases.some(c => batches[0].cases.some(a => normalize(a.prompt) === normalize(c.prompt)))) throw new Error('Repeated question batch');
const out = `reports/dynamic-generation-${skillId}-2026-09-05`;
await mkdir(out, { recursive: true });
await writeFile(`${out}/batches.json`, JSON.stringify(batches, null, 2));
console.log('PASS: two independently generated batches; no copied regression questions.');
