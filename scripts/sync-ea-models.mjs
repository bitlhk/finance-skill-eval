import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import path from 'node:path';

// Import only through the existing loopback admin RPC. EA remains read-only.
const gateway = process.env.EA_MODEL_GATEWAY ?? 'ws://127.0.0.1:19000/ws';
const url = new URL(gateway);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('EA model import requires a loopback gateway');
const entries = await new Promise((resolve, reject) => {
  const ws = new WebSocket(gateway), id = 'finance-eval-model-import';
  const timeout = setTimeout(() => { ws.close(); reject(new Error('EA model list timed out')); }, 15000);
  const finish = (error, result) => { clearTimeout(timeout); ws.close(); error ? reject(error) : resolve(result); };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'req', id, method: 'models.list', params: {} }));
  ws.onmessage = e => {
    const data = JSON.parse(String(e.data));
    if (data.id !== id || data.type !== 'res') return;
    finish(data.ok === false ? new Error('EA rejected model list') : null, data.payload?.models ?? []);
  };
  ws.onerror = () => finish(new Error('EA model gateway unavailable'));
});
if (!entries.length) throw new Error('EA returned an empty model catalog');
for (let extra = 0; extra < process.argv.length; extra++) {
  if (process.argv[extra] !== '--extra') continue;
  const id = process.argv[++extra];
  if (!id || id.startsWith('--')) throw new Error('--extra needs an upstream model ID');
  const source = entries.find(m => m.model_name === 'glm-5.2');
  if (!source) throw new Error('No GLM provider to probe');
  entries.push({ ...source, model_name: id, alias: '', is_default: false });
}
const groups = [...new Map(entries.map(m => [m.api_base, m])).values()];
for (const provider of groups) {
  try {
    const response = await fetch(`${provider.api_base.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${provider.api_key}` }, signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    console.log(JSON.stringify({ provider: new URL(provider.api_base).hostname, status: response.status,
      glmModels: (data.data ?? []).filter(m => /glm/i.test(m.id)).map(m => m.id) }));
  } catch { console.log(JSON.stringify({ provider: new URL(provider.api_base).hostname, discovery: 'unavailable' })); }
}
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ models: entries.map(m => ({ modelId: m.alias || m.model_name, upstreamModelId: m.model_name,
    provider: m.model_provider, credentialConfigured: Boolean(m.api_key) })) }));
  process.exit(0);
}
const runtimeFile = path.resolve('.runtime.local.json'), catalogFile = path.resolve('.models.local.json');
const original = await readFile(runtimeFile, 'utf8'), config = JSON.parse(original);
const previousCatalog = await readFile(catalogFile, 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const models = {}, catalog = [];
for (const entry of entries) {
  const id = entry.alias || entry.model_name;
  if (models[id]) throw new Error(`Duplicate EA model identity: ${id}`);
  if (!entry.api_key || !['OpenAI', 'OpenRouter', 'DeepSeek', 'DashScope', 'SiliconFlow'].includes(entry.model_provider)) {
    throw new Error(`Unsupported or unconfigured model: ${id}`);
  }
  const host = new URL(entry.api_base).hostname;
  const providerLabel = host.endsWith('volceapi.com') ? '火山网关' : host === 'api.modelarts-maas.com' ? '华为 MaaS' : host === 'openrouter.ai' ? 'OpenRouter' : entry.model_provider;
  const extraBody = host === 'openrouter.ai' ? { reasoning: { enabled: false } } : { thinking: { type: 'disabled' } };
  models[id] = { baseUrl: entry.api_base, apiKey: entry.api_key, upstreamModelId: entry.model_name,
    providerId: 'service-execution', providerLabel, extraBody, temperature: 0.2, maxTokens: 6000 };
  catalog.push({ providerId: 'service-execution', modelId: id, label: entry.alias || entry.model_name,
    providerLabel, parameters: {}, availability: 'unverified', statusNote: '已同步配置，待在线工具验证' });
}
const defaultModelId = previousCatalog?.defaultModelId ?? (entries[0].alias || entries[0].model_name);
if (!models[defaultModelId]) throw new Error(`Retained default model is missing from this import: ${defaultModelId}`);
await mkdir('data/model-imports', { recursive: true });
await writeFile(`data/model-imports/runtime-${Date.now()}.json`, original, { mode: 0o600 });
for (const [file, value] of [[runtimeFile, { ...config, defaultModelId, models }], [catalogFile, { schemaVersion: 'finance.skill-eval.execution-models.v1',
  importedAt: new Date().toISOString(), source: 'EA loopback models.list', defaultModelId, models: catalog }]]) {
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(`${file}.tmp`, 0o600);
  await rename(`${file}.tmp`, file);
}
console.log(JSON.stringify({ imported: catalog.length, models: catalog.map(m => m.modelId), credentials: 'server-side only' }));
