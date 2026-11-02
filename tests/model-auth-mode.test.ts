import {afterEach, expect, it, vi} from 'vitest';
import {OpenAiCompatibleModelAdapter} from '../src/openai-compatible-model.js';
import {configuredModelRole} from '../src/service/config.js';

afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

it.each(['bearer','raw'] as const)('sends exactly one Authorization value for %s',async authMode=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:'ok'}}]})));
  vi.stubGlobal('fetch',fetch);
  const adapter=new OpenAiCompatibleModelAdapter({baseUrl:'https://fixture.invalid/v1',apiKey:'test-key',authMode});
  await adapter.complete({requestId:'auth',model:{providerId:'fixture',modelId:'fixture',parameters:{}},messages:[]});
  expect(new Headers(fetch.mock.calls[0]![1].headers).get('authorization')).toBe(authMode==='raw'?'test-key':'Bearer test-key');
});

it('configures every API model role, permits role overrides and rejects invalid modes',async()=>{
  vi.stubEnv('FINANCE_EVAL_MODEL_BASE_URL','https://fixture.invalid/v1');
  vi.stubEnv('FINANCE_EVAL_MODEL_API_KEY','test-key');
  vi.stubEnv('FINANCE_EVAL_MODEL_AUTH_MODE','raw');
  for(const role of ['ANALYZER','JUDGE','EXECUTION','OPTIMIZER','MIGRATION'] as const){
    vi.stubEnv(`FINANCE_EVAL_${role}_PROVIDER`,'openai_compatible');
    vi.stubEnv(`FINANCE_EVAL_${role}_AUTH_MODE`,'raw');
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:'ok'}}]})));
    vi.stubGlobal('fetch',fetch);
    const configured=configuredModelRole(role);
    await configured.adapter!.complete({requestId:'auth',model:configured.model,messages:[]});
    expect(new Headers(fetch.mock.calls[0]![1].headers).get('authorization')).toBe('test-key');
  }
  vi.stubEnv('FINANCE_EVAL_JUDGE_AUTH_MODE','bearer');
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:'ok'}}]})));
  vi.stubGlobal('fetch',fetch);
  const judge=configuredModelRole('JUDGE');
  await judge.adapter!.complete({requestId:'auth',model:judge.model,messages:[]});
  expect(new Headers(fetch.mock.calls[0]![1].headers).get('authorization')).toBe('Bearer test-key');
  vi.stubEnv('FINANCE_EVAL_JUDGE_AUTH_MODE','invalid');
  expect(()=>configuredModelRole('JUDGE')).toThrow();
});
