import { fingerprint } from '../../contracts.js';
import type { RunConfiguration } from '../../shared/contracts/run-configuration.js';
import type { SkillAssetRecord } from '../../shared/contracts/skill-asset.js';

type SolutionEnvironment={
  selected:{environmentId:string};
  launcher:{environmentId:string;baseUrl:string;delivery?:{deploymentId:string;artifactSha256:string;capabilitiesDigest:string}};
};

export type SolutionRevision = {
  revisionId: string;
  bindingFingerprint?:string;
  skill: { assetId: string; artifactSha256: string };
  runtime: {
    environmentId: string;
    launcherEnvironmentId: string;
    deploymentId: string | null;
    artifactSha256: string | null;
    capabilitiesDigest: string | null;
    endpoint: string;
  };
  executionModelDigest: string;
  configurationDigest: string;
  toolBindingsDigest: string;
};

/** A run binds the actual Skill, tool configuration and deployed Launcher, not only the Skill ZIP. */
export function solutionRevision(input: {
  asset: SkillAssetRecord;
  side: 'left' | 'right';
  configuration: RunConfiguration;
  configurationDigest: string;
  environment: SolutionEnvironment;
  /** Verified online declaration for an existing Launcher; does not invent a build identity. */
  verifiedCapabilitiesDigest?: string;
}): SolutionRevision {
  const { asset, side, configuration, environment } = input;
  const model = configuration[side === 'left' ? 'leftExecutionModel' : 'rightExecutionModel'] ?? configuration.executionModel;
  const runtime = {
    environmentId: environment.selected.environmentId,
    launcherEnvironmentId: environment.launcher.environmentId,
    deploymentId: environment.launcher.delivery?.deploymentId ?? null,
    artifactSha256: environment.launcher.delivery?.artifactSha256 ?? null,
    capabilitiesDigest: input.verifiedCapabilitiesDigest ?? environment.launcher.delivery?.capabilitiesDigest ?? null,
    endpoint: environment.launcher.baseUrl,
  };
  const body = {
    skill: { assetId: asset.assetId, artifactSha256: asset.artifactSha256 },
    runtime,
    executionModelDigest: fingerprint(model ?? null),
    configurationDigest: input.configurationDigest,
    toolBindingsDigest: fingerprint({
      commands: configuration.runtimeCommandBindings?.[side] ?? [],
      mcp: configuration.runtimeMcpBindings?.[side] ?? [],
      toolConfig: configuration.runtimeToolConfig ?? null,
      harnessTools: configuration.runtimeHarnessTools ?? [],
    }),
  };
  const identity={...body,skill:{artifactSha256:asset.artifactSha256},runtime:{deploymentId:runtime.deploymentId,artifactSha256:runtime.artifactSha256,capabilitiesDigest:runtime.capabilitiesDigest}};
  return { revisionId: fingerprint(identity),bindingFingerprint:fingerprint(runtime), ...body };
}

export function sameSolutionRevision(left: SolutionRevision, right: SolutionRevision): boolean {
  return left.revisionId === right.revisionId;
}
