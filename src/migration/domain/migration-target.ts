import type { RuntimeExecutionEvidence } from '../../contracts.js';

export type MigrationNativeTarget={
  hostId:'finance-migration-openjiuwen-reference-v1';version:'0.1.13';hostSha256:string;
  sdkSha256:'65561515ace2d44a1f2448d54fcdf2a2e09eadb8ba5be715836975f3fc4d64ea';
  modelId:string;modelConfigured:true;sourceKind:'CONTROLLED_SYNTHETIC_BANK';fixturesSha256:string;portsSha256:string;
  profiles:Record<string,{label:string;skillId:string;schemaBasis:string;
    tools:Array<{name:string;description:string;inputSchema:Record<string,unknown>;outputSchema:Record<string,unknown>}>;
    cases:Array<{caseId:string;label:string;expect:'completed'|'denied';prompt:string}>}>;
};
export type MigrationTargetRun={
  id:string;candidateDigest:string;assetId:string;startedAt:string;finishedAt?:string;
  status:'RUNNING'|'PASSED'|'FAILED'|'INTERRUPTED';error?:string;profile:string;runnerInstanceId?:string;
  target:MigrationNativeTarget;
  cases:Array<{caseId:string;label:string;passed:boolean;evidence:RuntimeExecutionEvidence}>;
};
