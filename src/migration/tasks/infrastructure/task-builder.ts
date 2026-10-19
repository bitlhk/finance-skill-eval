import { createHash } from 'node:crypto';
import type { EnvironmentStore } from '../../../service/environment-store.js';
import { bundleZip, bundleError, configurationSchema } from '../domain/task-model.js';
import type { TaskBuilderPort } from '../application/task-ports.js';
import { createBundleRuntime } from './task-runtime.js';
import { canonicalSha256 } from '../../../shared/json-canonicalization.js';

export function createTaskBuilder(environments: EnvironmentStore, options: { managed?: boolean } = {}): TaskBuilderPort {
  return { async accept(input) {
    const { request, snapshot, services } = input;
    if (options.managed && (services.length || request.settings.harnessTools.length)) bundleError('托管工作区的自定义工具需要先由环境维护者接入', 403);
    const archive = bundleZip(snapshot.files);
    const accepted = await environments.acceptBuilderDelivery({
      requirements: request.requirements, result: input.result, trustReference: input.trustReference, name: input.name,
      bundleConformance: {
        bundle: { digest: snapshot.digest, members: snapshot.members, archiveBase64: archive.toString('base64'),
          archiveSha256: createHash('sha256').update(archive).digest('hex'),
          ...(request.settings.entryInstructionsFile ? { entryInstructionsFile: request.settings.entryInstructionsFile } : {}) },
        environment: { environmentId: 'builder-conformance', harnessToolNames: request.settings.harnessTools,
          candidateMcpServices: services.map(s => ({ ...s, assetDigest: snapshot.digest })) },
        modelId: request.settings.modelId, timeoutMs: request.settings.timeoutMs,
      },
    });
    const configuration = configurationSchema.parse({ ...request.settings, environmentId: accepted.environment.environmentId,
      modelId: request.settings.modelId ?? accepted.capabilities.defaultModelId });
    const execution = await createBundleRuntime(environments, options)({ snapshot, services, configuration, signal: AbortSignal.timeout(60000) });
    const live = execution.environmentSnapshot as { capabilities: unknown };
    if (canonicalSha256(live.capabilities) !== input.result.launcher?.capabilitiesDigest) bundleError('Builder 环境能力在接收期间发生变化，请重新交付');
    // Registered delivery is reusable even if the task write fails; never delete an environment another task may use.
    return { configuration, environmentSnapshot: execution.environmentSnapshot,
      launcher: { ...accepted.environment.delivery!, environmentId: accepted.environment.environmentId } };
  } };
}
