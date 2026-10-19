import Fastify from 'fastify';

// Deterministic protocol fixture. It is not a real Agent, Builder or business Runtime.
export async function taskBuilderLauncher() {
  const caps = {
    schemaVersion: 'finance.skill-eval.runtime-capabilities.v1', runtime: { type: 'openjiuwen', version: 'fixture-1' },
    models: [{ modelId: 'execution', upstreamModelId: 'fixture' }], defaultModelId: 'execution',
    observability: { schemaVersion: 'finance.runtime-observation-capabilities.v1', profile: 'core', supportedKinds: ['execution.started', 'execution.completed', 'execution.failed'], nativeEvents: false, replayable: false },
    features: { streaming: false, asyncLaunch: false, packagedMcp: true, externalMcp: false, inlineSecrets: true, multiSkill: true },
    limits: { maxArchiveBytes: 8388608, maxFiles: 1000, maxTimeoutMs: 900000, maxConcurrentInstances: 2 },
  };
  const app = Fastify(), instances = new Map(), lifecycle = [], creations = [];
  const control = { badMembers: false, badDigest: false, cleanupFailure: false, failExecution: false, executeGate: null };
  const state = id => ({ schemaVersion: 'finance.skill-eval.runtime-instance-state.v1', instanceId: id, status: 'ready', executeEndpoint: `/v1/runtime-instances/${id}/execute`, expiresAt: new Date(Date.now()+600000).toISOString(), error: null, configurationDigest: 'config-'+id });
  app.get('/v1/runtime-capabilities', () => caps);
  app.post('/v1/runtime-instances', request => {
    const id = 'instance-'+(creations.length+1); creations.push(request.body); instances.set(id, request.body); lifecycle.push('create'); return state(id);
  });
  app.get('/v1/runtime-instances/:id', request => { lifecycle.push('status'); return state(request.params.id); });
  app.post('/v1/runtime-instances/:id/execute', async request => {
    lifecycle.push('execute'); if(control.executeGate) await control.executeGate;
    const instance = instances.get(request.params.id), members = instance.skills.map(({instructions,files,...member})=>member);
    return { runId: instance.runId, side: 'right', caseId: request.body.caseId, modelId: instance.modelId, skillVersion: 'frozen',
      status: control.failExecution ? 'failed' : 'completed', output: request.body.caseId === 'launcher-lifecycle' ? 'CONFORMANCE_OK' : 'BUSINESS_OK',
      elapsedMs: 1, toolCalls: [], loadedSkills: members.map(m => ({skillId:m.skillId,version:m.version})), usage: null,
      runtimeIdentityVerified: true, streamCompleted: true, error: null,
      metadata: { contentDigest: control.badDigest ? 'x'.repeat(64) : instance.contentDigest,
        loadedSkillMembers: control.badMembers ? members.slice(1) : members,
        instanceConfigurationDigest: state(request.params.id).configurationDigest, workspaceFilesDigest: null } };
  });
  app.delete('/v1/runtime-instances/:id', (request, reply) => {
    lifecycle.push('delete'); if(control.cleanupFailure) return reply.code(500).send({error:'CLEANUP_FAILED'});
    instances.delete(request.params.id); return reply.code(204).send();
  });
  await app.listen({host:'127.0.0.1',port:0});
  return { app, baseUrl: `http://127.0.0.1:${app.server.address().port}/`, caps, control, lifecycle, creations, instances };
}
export function taskBuilderResult(requirements, host, withResultDigest, canonicalSha256, suffix='1') {
  const profile = requirements.extensions.migrationTask;
  return withResultDigest({ schemaVersion:requirements.schemaVersion.replace('requirements','result'), buildId:'build-'+suffix, requestId:requirements.requestId,
    requirementsDigest:requirements.requirementsDigest, status:'SUCCEEDED', builder:{name:'protocol-fixture',version:'1'},
    launcher:{schemaVersion:'finance.runtime-launcher-descriptor.v1',deploymentId:'deployment-'+suffix,baseUrl:host.baseUrl,
      runtime:host.caps.runtime,protocols:requirements.target.protocols,authentication:{type:'none'},artifactSha256:canonicalSha256(suffix),capabilitiesDigest:canonicalSha256(host.caps),expiresAt:null},
    capabilityResults:[],verifications:[],errors:[],builtAt:new Date().toISOString(),
    extensions:{migrationTask:{schemaVersion:profile.schemaVersion.replace('profile','receipt'),taskId:profile.taskId,candidateId:profile.candidateId,candidateDigest:profile.candidateDigest,instanceSchemaVersion:profile.instanceSchemaVersion}} });
}
