import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { createEvaluationService } from '../dist/service/server.js';

/**
 * The migration pipeline against the real agents and a real model.
 *
 * Every other check in this repo stands the agents in: the UI acceptance stubs A2 and A4, the
 * scaffold verifier only compiles what the skill package says. That leaves one claim untested --
 * that the agents, reading a real package, produce an analysis and an implementation the platform
 * accepts -- and it is the claim the product rests on.
 *
 * It needs a live model, so it is not in CI and not part of `pnpm test`. Run it from the repo root:
 *
 *   node --env-file=.env.local scripts/verify-real-agent-migration.mjs
 *
 * Requires: `.runtime.local.json` (the agents' own config, see .runtime.local.example.json),
 * `.venv-openjiuwen` (scripts\start-openjiuwen.cmd --setup), and the roles in `.env.local`.
 */
const FIXTURE = path.resolve('acceptance/openjiuwen-portability/legacy-skill');
const data = await mkdtemp(path.join(os.tmpdir(), 'real-agent-migration-'));
const token = 'real-agent-migration';
const checks = [];

async function fixtureZip() {
  const files = {};
  for (const name of await readdir(FIXTURE, { recursive: true })) {
    const segments = name.split(/[\\/]/);
    if (segments.includes('__pycache__')) continue;
    const content = await readFile(path.join(FIXTURE, name)).catch(error => error.code === 'EISDIR' ? null : Promise.reject(error));
    if (content) files[name.replaceAll('\\', '/')] = new Uint8Array(content);
  }
  // The platform reads `skill/...`; the fixture directory is the Skill itself.
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [`skill/${name}`, bytes]))));
}

const app = await createEvaluationService({
  rootDirectory: process.cwd(), dataDirectory: data, accessToken: token, publicDemo: false,
});
const headers = { authorization: `Bearer ${token}` };
const post = (url, payload = {}) => app.inject({ method: 'POST', url, headers, payload });
const fail = message => { throw new Error(message); };

try {
  const uploaded = (await app.inject({ method: 'POST', url: '/api/migrations/upload',
    headers: { ...headers, 'content-type': 'application/zip' }, payload: await fixtureZip() })).json();
  const project = (await post('/api/migrations', { sourceAssetId: uploaded.assetId, name: 'real agents' })).json();

  // A2: the analysis is the only source of tools and of the baseline.
  const inspected = await post(`/api/migrations/${project.id}/inspect`);
  if (inspected.statusCode !== 200) fail(`A2 did not produce an analysis: ${inspected.statusCode} ${inspected.json().message}`);
  const inspection = inspected.json();
  const tools = inspection.tools ?? [];
  if (!tools.length) fail('A2 produced no tools for a package that calls two');
  for (const tool of tools) {
    const kinds = new Set((tool.evidence ?? []).map(item => item.kind));
    // "Read the contract" means the claim landed somewhere real. Whether a Schema came with it is
    // the agent's separate call: it is allowed to say "读不出来", and that is a finding, not a hole
    // in the analysis. So the assertion is on the located evidence, not on the Schema.
    if (!kinds.has('INPUT_CONTRACT')) fail(`A2 located no input contract for ${tool.name}`);
    if (!kinds.has('OUTPUT_CONTRACT')) fail(`A2 located no output contract for ${tool.name}`);
    if (!tool.sourcePaths.length) fail(`A2 placed no source for ${tool.name}`);
  }
  checks.push({ step: 'A2_analysis', skill: inspection.skill.status, tools: tools.map(tool => ({ name: tool.name, portability: tool.portability,
    language: tool.language, recommendedForm: tool.recommendedForm, inputSchema: !!tool.inputSchema, outputSchema: !!tool.outputSchema,
    samples: tool.samples?.length ?? 0, evidence: (tool.evidence ?? []).map(item => item.kind) })) });

  // A3: a human authorises. One MCP, one Script -- the mix the fixture exists to exercise.
  const [first, second] = tools;
  const forms = [[first, 'MCP'], [second, 'SCRIPT']];
  for (const [tool, form] of forms) {
    const decided = await app.inject({ method: 'PUT', url: `/api/migrations/${project.id}/tools/${tool.toolId}/decision`,
      headers, payload: { form, baseAssetId: inspection.assetId } });
    if (decided.statusCode !== 200) fail(`A3 refused ${form} for ${tool.name}: ${decided.json().message}`);
  }

  // A4: the agent writes the implementation, including the service shell.
  const generated = await post(`/api/migrations/${project.id}/generate`, { baseAssetId: inspection.assetId });
  if (generated.statusCode !== 200) fail(`A4 did not deliver a candidate: ${generated.statusCode} ${generated.json().message}`);
  const value = generated.json();
  if (!value.candidate) fail('A4 returned no candidate');
  for (const item of value.portableGenerations ?? []) {
    if (!item.readyForValidation) fail(`${item.toolName} was delivered with unfinished work: ${item.todo?.join('、')}`);
  }
  checks.push({ step: 'A4_delivery', candidateVersion: value.candidate.version,
    files: (value.portableGenerationDiff ?? []).map(item => `${item.operation} ${item.path}`),
    generations: (value.portableGenerations ?? []).map(item => ({ tool: item.toolName, form: item.form,
      entrypoint: item.entrypoint, start: item.start, prepare: item.prepare, attempts: item.attempts,
      checks: item.checks?.map(check => check.name), drift: item.drift?.length ?? 0, changes: item.changes?.length ?? 0 })) });

  // The test set, written from the analysis by the analyzer role.
  const suite = await post(`/api/migrations/${project.id}/suites/generated`, { baseAssetId: value.candidate.assetId });
  if (suite.statusCode !== 200) fail(`the test set was not generated: ${suite.statusCode} ${suite.json().message}`);
  const produced = suite.json();
  checks.push({ step: 'test_set', source: produced.source, cases: produced.cases.map(item => ({ caseId: item.caseId, requiredTools: item.requiredTools })) });

  // The service logs to stdout, so a six-minute run's result would otherwise arrive interleaved
  // with request lines -- unreadable by a person and unparseable by a script. The report goes to a
  // file; stdout gets the headline.
  await mkdir(path.resolve('reports'), { recursive: true });
  await writeFile(path.resolve('reports/real-agent-migration.json'), `${JSON.stringify({ mode: 'REAL_AGENTS_REAL_MODEL', checks }, null, 2)}\n`);
  process.stdout.write(`real-agent-migration: ${checks.map(check => check.step).join(' → ')}；明细见 reports/real-agent-migration.json\n`);
} finally {
  await app.close();
  await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
