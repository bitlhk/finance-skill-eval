import { expect, it } from 'vitest';
import { solutionRevision } from '../src/migration/domain/migration-solution-revision.js';
import type { ResolvedMigrationEnvironment } from '../src/migration/application/migration-environment-repository.js';
import type { RunConfiguration } from '../src/shared/contracts/run-configuration.js';
import type { SkillAssetRecord } from '../src/shared/contracts/skill-asset.js';

const asset={assetId:'skill-1',artifactSha256:'a'.repeat(64)} as SkillAssetRecord;
const launcher={
  environmentId:'env-1',type:'runtime_launcher',baseUrl:'https://runtime.example.test/one/',
  delivery:{deploymentId:'deployment-1',artifactSha256:'b'.repeat(64),capabilitiesDigest:'c'.repeat(64)},
} as ResolvedMigrationEnvironment['launcher'];
const environment:ResolvedMigrationEnvironment={selected:launcher,launcher};
const configuration={
  executionModel:{providerId:'runtime-launcher:env-1',modelId:'glm',parameters:{temperature:0}},
  runtimeMcpBindings:{left:[],right:[{assetDigest:'a'.repeat(64),toolNames:['lookup'],filePaths:['tools/lookup.py'],start:['python','tools/lookup.py']}]},
} as RunConfiguration;
const revision=(changes:Partial<Parameters<typeof solutionRevision>[0]>={})=>solutionRevision({asset,side:'right',configuration,configurationDigest:'d'.repeat(64),environment,...changes});

it('identifies a complete runnable solution rather than the Skill ZIP alone',()=>{
  const first=revision();
  expect(revision().revisionId).toBe(first.revisionId);
  expect(first.runtime).toMatchObject({deploymentId:'deployment-1',artifactSha256:'b'.repeat(64)});
  const relocated=revision({environment:{selected:{...launcher,baseUrl:'https://runtime.example.test/two/'},launcher:{...launcher,baseUrl:'https://runtime.example.test/two/'}}});
  expect(relocated.revisionId).toBe(first.revisionId);
  expect(relocated.bindingFingerprint).not.toBe(first.bindingFingerprint);
  expect(revision({asset:{...asset,assetId:'another-upload'}}).revisionId).toBe(first.revisionId);
  expect(revision({environment:{selected:{...launcher,delivery:{...launcher.delivery!,artifactSha256:'e'.repeat(64)}},launcher:{...launcher,delivery:{...launcher.delivery!,artifactSha256:'e'.repeat(64)}}}}).revisionId).not.toBe(first.revisionId);
  expect(revision({configurationDigest:'e'.repeat(64)}).revisionId).not.toBe(first.revisionId);
  expect(revision({configuration:{...configuration,runtimeMcpBindings:{left:[],right:[]}}}).revisionId).not.toBe(first.revisionId);
  expect(revision({configuration:{...configuration,executionModel:{providerId:'runtime-launcher:env-1',modelId:'other',parameters:{}}}}).revisionId).not.toBe(first.revisionId);
  expect(revision({asset:{...asset,artifactSha256:'f'.repeat(64)}}).revisionId).not.toBe(first.revisionId);
});

it('pins a verified reused capabilities declaration without inventing Builder provenance',()=>{
 const existing={...launcher,delivery:undefined};
 const base=revision({environment:{selected:existing,launcher:existing},verifiedCapabilitiesDigest:'d'.repeat(64)});
 expect(base.runtime).toMatchObject({deploymentId:null,artifactSha256:null,capabilitiesDigest:'d'.repeat(64)});
 expect(revision({environment:{selected:existing,launcher:existing},verifiedCapabilitiesDigest:'e'.repeat(64)}).revisionId).not.toBe(base.revisionId);
 expect(revision({environment:{selected:existing,launcher:existing}}).revisionId).not.toBe(base.revisionId);
});
