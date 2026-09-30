export type SkillAssetRecord = {
  schemaVersion: 'finance.skill-eval.skill-asset.v1';
  assetId: string;
  skillId: string;
  version: string;
  displayName: string;
  description: string;
  sourceType: 'uploaded';
  artifactSha256: string;
  skillFile: string;
  fileCount: number;
  createdAt: string;
};
