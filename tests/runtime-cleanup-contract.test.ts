import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {runtimeCleanupObservationSchema} from '../src/shared/contracts/runtime-launcher.js';
import {runtimeLauncherResponseError} from '../src/runtime-launcher.js';

const receipt={schemaVersion:'finance.eval-cleanup-observation.v1',instanceId:'eval-owned',observedAt:'2026-10-09T00:00:00Z',status:'RELEASED',scope:'LAUNCHER_MANAGED_RESOURCES'};
it('publishes the same portable cleanup fields and statuses as the receiver',()=>{
  const schema=JSON.parse(readFileSync(new URL('../contracts/runtime-launcher/finance.eval-cleanup-observation.v1.schema.json',import.meta.url),'utf8'));
  expect(schema.required.sort()).toEqual(Object.keys(receipt).sort());
  for(const status of schema.properties.status.enum)expect(runtimeCleanupObservationSchema.parse({...receipt,status}).status).toBe(status);
  expect(runtimeCleanupObservationSchema.parse({...receipt,privatePath:'C:/secret',token:'secret'})).toEqual(receipt);
  for(const change of [{status:'DONE'},{instanceId:'C:/private'},{observedAt:'yesterday'},{scope:'ALL_OS_RESOURCES'}])expect(runtimeCleanupObservationSchema.safeParse({...receipt,...change}).success).toBe(false);
});
it('preserves actionable qualification errors without exposing upstream details',async()=>{
  const error=await runtimeLauncherResponseError(Response.json({error:'EVAL_RUNTIME_QUALIFICATION_REQUIRED',path:'C:/secret',key:'canary'},{status:503}));
  expect(error.message).toContain('Builder 管理者');expect(error.message).toContain('EVAL_RUNTIME_QUALIFICATION_REQUIRED');expect(error.message).not.toContain('canary');
  const privateError=await runtimeLauncherResponseError(Response.json({error:'private error C:/secret key=canary'},{status:503}));
  expect(privateError.message).toBe('Runtime Launcher HTTP 503');
});
