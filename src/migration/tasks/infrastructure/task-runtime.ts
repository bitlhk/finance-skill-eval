import { createHash } from 'node:crypto';
import type { EnvironmentStore } from '../../../service/environment-store.js';
import { RuntimeLauncherAdapter } from '../../../runtime-launcher.js';
import { bundleError, bundleZip, readText } from '../domain/task-model.js';
import type { BundleRuntimeFactory } from '../application/task-ports.js';
import type { RuntimeEnvironmentDescriptor } from '../../../http-runtime.js';
export function createBundleRuntime(
  environments: EnvironmentStore,
  options: { managed?: boolean; } = {},
): BundleRuntimeFactory {
  return async ({ snapshot, configuration, services, signal }) => {
    signal.throwIfAborted();
    if (options.managed && (services.length || configuration.harnessTools.length))
      bundleError(
        '托管工作区只允许已准入的工具；整组自定义脚本、MCP 与 Harness 需要先由执行环境维护者接入',
        403,
      );
    const selected = await environments.requireAvailable(configuration.environmentId);
    const { launcher, mcpEnvironmentIds } = await environments.resolveLauncher(selected);
    const probe = await environments.preflight(launcher);
    if (probe.status !== 'ready' || !('capabilities' in probe) || !probe.capabilities)
      bundleError('运行环境不可用');
    const capabilities = probe.capabilities;
    if (!capabilities.features.multiSkill)
      bundleError('所选 Runtime 尚不支持整组 Skill 装载，请升级 Launcher');
    if (!capabilities.models.some((m) => m.modelId === configuration.modelId))
      bundleError('运行环境不提供所选模型');
    if (configuration.timeoutMs > capabilities.limits.maxTimeoutMs)
      bundleError('验收超时设置超过 Runtime 限制');
    const archive = bundleZip(snapshot.files);
    if (
      archive.length > capabilities.limits.maxArchiveBytes ||
      Object.keys(snapshot.files).length > capabilities.limits.maxFiles
    )
      bundleError('整组包超过目标 Runtime 的容量限制');
    if (configuration.entryInstructionsFile) readText(snapshot.files, configuration.entryInstructionsFile);
    if (services.length && !capabilities.features.packagedMcp)
      bundleError('Runtime 不支持候选中的共享 MCP 服务');
    if (mcpEnvironmentIds.length && !capabilities.features.externalMcp)
      bundleError('Runtime 不支持绑定的外部 MCP 服务');
    const mcpServers: NonNullable<RuntimeEnvironmentDescriptor['mcpServers']> = [];
    const externalVersions: Array<{ id: string; updatedAt: string; }> = [];
    for (const id of mcpEnvironmentIds) {
      const server = await environments.requireAvailable(id);
      if (server.type !== 'mcp_streamable_http') bundleError('外部工具绑定不是 MCP 服务');
      externalVersions.push({ id: server.environmentId, updatedAt: server.updatedAt });
      const credential = server.credentialEnv ? process.env[server.credentialEnv] : undefined;
      if (server.credentialEnv && !credential) bundleError('外部 MCP 凭据尚未配置');
      mcpServers.push({
        serverId: server.environmentId,
        endpoint: server.endpoint,
        transport: 'streamable_http',
        toolNames: [],
        ...(credential
          ? {
            secretHeaders: {
              authorization: credential.startsWith('Bearer ') ? credential : 'Bearer ' + credential,
            },
          }
          : {}),
      });
    }
    const model = { providerId: 'runtime-launcher', modelId: configuration.modelId, parameters: {} };
    let headers: Record<string, string> = {};
    if (launcher.credentialEnv) {
      const value = process.env[launcher.credentialEnv];
      if (!value) bundleError('运行环境凭据尚未配置');
      headers = { authorization: value.startsWith('Bearer ') ? value : 'Bearer ' + value };
    }
    const runtime = new RuntimeLauncherAdapter({
      baseUrl: launcher.baseUrl,
      headers,
      side: 'right',
      model,
      skill: null,
      variant: {
        mode: 'skill_version',
        skillId: 'bundle',
        version: 'frozen',
        artifactSha256: snapshot.digest,
      },
      bundle: {
        digest: snapshot.digest,
        members: snapshot.members,
        archiveBase64: archive.toString('base64'),
        archiveSha256: createHash('sha256').update(archive).digest('hex'),
        ...(configuration.entryInstructionsFile
          ? { entryInstructionsFile: configuration.entryInstructionsFile }
          : {}),
      },
      environment: {
        environmentId: configuration.environmentId,
        harnessToolNames: configuration.harnessTools,
        mcpServers,
        candidateMcpServices: services.map((service) => ({ ...service, assetDigest: snapshot.digest })),
      },
      timeoutMs: configuration.timeoutMs,
    });
    return {
      runtime,
      model,
      environmentSnapshot: {
        environmentId: selected.environmentId,
        updatedAt: selected.updatedAt,
        launcherId: launcher.environmentId,
        launcherUpdatedAt: launcher.updatedAt,
        externalVersions,
        capabilities,
      },
    };
  };
}
