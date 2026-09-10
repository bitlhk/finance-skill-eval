import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
const catalog = JSON.parse(await readFile('.models.local.json', 'utf8'));
const runtime = JSON.parse(await readFile('.runtime.local.json', 'utf8'));
const selected = process.argv.slice(2).filter(a => !a.startsWith('--'));
const report = [];
const base = 'http://127.0.0.1:56362';
await mkdir('reports/model-verification', { recursive: true });
for (const model of catalog.models.filter(m => !selected.length || selected.includes(m.modelId))) {
  const started = Date.now();
  let evidence, failure;
  const body = { schemaVersion: 'finance.skill-eval.runtime-request.v1', runId: `model-smoke-${started}`,
    side: 'left', model: { providerId: model.providerId, modelId: model.modelId, parameters: {} },
    case: { caseId: 'MODEL-TOOL-SMOKE', prompt: '请调用 account_balance_query 核验模拟账户 acct-demo-001 的可用余额和币种。必须实际查询，然后用一句中文回答；不要转账。', requiredTools: ['account_balance_query'] },
    variant: { mode: 'without_target_skill', skillId: 'model-smoke' }, skill: null,
    environment: { mcpServers: [{ endpoint: 'http://127.0.0.1:56363/mcp', toolNames: ['account_balance_query'] }] } };
  try {
    const response = await fetch(`${base}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(130000) });
    const raw = await response.text();
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const item = JSON.parse(line.slice(6));
      if (item.evidence) evidence = item.evidence;
    }
    if (!response.ok) failure = `Runtime HTTP ${response.status}`;
    else if (!evidence) failure = 'No terminal runtime evidence';
    else if (evidence.status !== 'completed') failure = evidence.error;
    else if (!evidence.toolCalls.some(t => t.name === 'account_balance_query' && t.status === 'completed')) failure = 'Model did not call the required tool';
    else if (!/80[,，]?000|8[.0]*\s*万/.test(evidence.output)) failure = 'Answer did not use the tool balance';
  } catch (error) { failure = error.name === 'TimeoutError' ? 'Tool round trip exceeded 130 seconds' : 'Runtime transport unavailable'; }
  const result = { modelId: model.modelId, upstreamModelId: runtime.models[model.modelId].upstreamModelId,
    passed: !failure, elapsedMs: Date.now() - started, error: failure ?? null, evidence };
  report.push(result);
  await writeFile(`reports/model-verification/${started}.json`, JSON.stringify(result, null, 2) + '\n');
  model.availability = failure ? 'unavailable' : 'ready';
  model.statusNote = failure ? `工具验证未通过：${failure.slice(0, 180)}` : `工具调用与回答已验证 · ${new Date().toISOString()}`;
  // Availability belongs to the service catalog; retain worker bindings for maintainer retests.
  await writeFile('.models.local.json.tmp', JSON.stringify(catalog, null, 2) + '\n', { mode: 0o600 });
  await rename('.models.local.json.tmp', '.models.local.json');
  console.log(JSON.stringify({ modelId: result.modelId, passed: result.passed, elapsedMs: result.elapsedMs, error: result.error }));
}
console.log(JSON.stringify({ tested: report.length, passed: report.filter(r => r.passed).length, failed: report.filter(r => !r.passed).map(r => r.modelId) }));
