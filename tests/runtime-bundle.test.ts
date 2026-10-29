import { runtimeSkillSetFromFiles } from '../src/shared/contracts/runtime-skills.js';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { RuntimeLauncherAdapter } from '../src/runtime-launcher.js';
import { snapshot, bundleZip } from '../src/migration/bundle/bundle-model.js';
import { evalCaseSchema } from '../src/contracts.js';
it('sends inline v2 Skills without an archive over HTTP and rejects partial or forged load receipts', async () => {
  const files = Object.fromEntries(
    ['budget', 'rules'].map((name) => [
      'skills/' + name + '/SKILL.md',
      Buffer.from('---\nname: ' + name + '\ndescription: test\n---\nUse tools.').toString('base64'),
    ]),
  );
  const bundle = snapshot(files, 'r1'),
    zip = bundleZip(files),
    model = { providerId: 'test', modelId: 'execution', parameters: {} };
  const variant = {
    mode: 'skill_version' as const,
    skillId: 'bundle',
    version: 'frozen',
    artifactSha256: bundle.digest,
  };
  const server = Fastify();
  let created: any,
    broken = false,
    deleted = 0;
  const keys:string[]=[];const retired=new Set<string>();
  server.get('/v1/runtime-capabilities', () => ({
    schemaVersion: 'finance.runtime-capabilities.v1',
    instanceSchemaVersion:'finance.runtime-instance.v1',
    platform:{os:'linux',arch:'x64',isolation:'trusted_local_process'},
    runtime: { type: 'test', version: '1' },
    models: [{ modelId: 'execution', upstreamModelId: 'test' }],
    defaultModelId: 'execution',
    features: {
      streaming: false,
      asyncLaunch: false,
      packagedMcp: true,
      externalMcp: true,
      inlineSecrets: true,

    },
    limits: { maxSkills:10, maxArchiveBytes: 8388608, maxFiles: 1000, maxTimeoutMs: 900000, maxConcurrentInstances: 2 },
  }));
  server.post('/v1/runtime-instances', (request,reply) => {
    const key=request.headers['idempotency-key'] as string;
    if(retired.has(key))return reply.code(410).send({error:'INSTANCE_EXPIRED'});
    keys.push(key);created = request.body;
    return {
      schemaVersion: 'finance.skill-eval.runtime-instance-state.v1',
      instanceId: 'test',
      status: 'ready',
      executeEndpoint: '/v1/runtime-instances/test/execute',
      expiresAt: '2030-01-01T00:00:00Z',
      error: null,
      configurationDigest: 'config',
    };
  });
  server.post('/v1/runtime-instances/test/execute', () => ({
    runId: 'run',
    caseId: 'case',
    side: 'right',
    modelId: 'execution',
    skillVersion: 'frozen',
    status: 'completed',
    output: 'done',
    elapsedMs: 1,
    toolCalls: [],
    loadedSkills: bundle.members.map((m) => ({ skillId: m.skillId, version: m.version })),
    usage: null,
    runtimeIdentityVerified: true,
    streamCompleted: true,
    error: null,
    metadata: {
      contentDigest: bundle.digest,
      loadedSkillMembers: broken ? bundle.members.slice(0, 1) : bundle.members,
      instanceConfigurationDigest: 'config',
      workspaceFilesDigest: null,
    },
  }));
  server.delete('/v1/runtime-instances/test', (_, reply) => {
    deleted++;retired.add(keys.at(-1)!);
    return {cleanup:{schemaVersion:'finance.eval-cleanup-observation.v1',status:'RELEASED',instanceId:'test',scope:'LAUNCHER_MANAGED_RESOURCES',observedAt:new Date().toISOString()}};
  });
  const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  const runtime = new RuntimeLauncherAdapter({
    baseUrl,
    model,
    variant,
    side: 'right',
    skill: null,
    skillSet: runtimeSkillSetFromFiles(bundle),
    environment: { environmentId: 'test' },
    timeoutMs: 10000,
  });
  try {
    await runtime.prepare({ runId: 'run' });
    expect(created.schemaVersion).toBe('finance.runtime-instance.v1');
    expect(created).not.toHaveProperty('skill');expect(created).not.toHaveProperty('variant');expect(created).not.toHaveProperty('bundle');
    expect(created.skills).toHaveLength(2);expect(created.assets).toBeUndefined();
    await runtime.prepare({runId:'run'});expect(keys[1]).toBe(keys[0]);
    const evalCase = evalCaseSchema.parse({
      caseId: 'case',
      name: 'case',
      prompt: 'task',
      evaluationGoal: 'goal',
      requiredTools: [],
      rubric: [
        { criterionId: 'one', label: 'one', description: 'one', dimension: 'professional_fit', weight: 1 },
      ],
    });
    expect(
      (await runtime.execute({ runId: 'run', side: 'right', model, variant, evalCase })).loadedSkills,
    ).toHaveLength(2);
    broken = true;
    await expect(runtime.execute({ runId: 'run', side: 'right', model, variant, evalCase })).rejects.toThrow(
      '清单',
    );
  } finally {
    await runtime.cleanup();
    const next=new RuntimeLauncherAdapter({baseUrl,model,variant,side:'right',skill:null,skillSet:runtimeSkillSetFromFiles(bundle),environment:{environmentId:'test'},timeoutMs:10000});
    await next.prepare({runId:'run'});expect(keys.at(-1)).not.toBe(keys[0]);await next.cleanup();
    await server.close();
  }
  expect(deleted).toBe(2);
});
