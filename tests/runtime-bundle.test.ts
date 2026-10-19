import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { RuntimeLauncherAdapter } from '../src/runtime-launcher.js';
import { snapshot, bundleZip } from '../src/migration/bundle/bundle-model.js';
import { evalCaseSchema } from '../src/contracts.js';
it('sends a v2 full bundle over HTTP and rejects partial or forged load receipts', async () => {
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
  server.get('/v1/runtime-capabilities', () => ({
    schemaVersion: 'finance.skill-eval.runtime-capabilities.v1',
    runtime: { type: 'test', version: '1' },
    models: [{ modelId: 'execution', upstreamModelId: 'test' }],
    defaultModelId: 'execution',
    features: {
      streaming: false,
      asyncLaunch: false,
      packagedMcp: true,
      externalMcp: true,
      inlineSecrets: true,
      multiSkill: true,
    },
    limits: { maxArchiveBytes: 8388608, maxFiles: 1000, maxTimeoutMs: 900000, maxConcurrentInstances: 2 },
  }));
  server.post('/v1/runtime-instances', (request) => {
    created = request.body;
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
      bundleDigest: bundle.digest,
      loadedBundleMembers: broken ? bundle.members.slice(0, 1) : bundle.members,
      instanceConfigurationDigest: 'config',
      workspaceFilesDigest: null,
    },
  }));
  server.delete('/v1/runtime-instances/test', (_, reply) => {
    deleted++;
    return reply.code(204).send();
  });
  const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  const runtime = new RuntimeLauncherAdapter({
    baseUrl,
    model,
    variant,
    side: 'right',
    skill: null,
    bundle: {
      digest: bundle.digest,
      members: bundle.members,
      archiveBase64: zip.toString('base64'),
      archiveSha256: createHash('sha256').update(zip).digest('hex'),
    },
    environment: { environmentId: 'test' },
    timeoutMs: 10000,
  });
  try {
    await runtime.prepare({ runId: 'run' });
    expect(created.schemaVersion).toBe('finance.skill-eval.runtime-instance.v2');
    expect(created.skill).toBeNull();
    expect(created.bundle.members).toHaveLength(2);
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
    await server.close();
  }
  expect(deleted).toBe(1);
});
