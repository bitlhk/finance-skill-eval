import { runtimeSkillSetFromFiles } from '../src/shared/contracts/runtime-skills.js';
import { snapshot } from '../src/migration/tasks/domain/task-model.js';
export const standardSnapshot=snapshot({'SKILL.md':Buffer.from('---\nname: fixture\ndescription: Controlled test Skill\n---\nFollow the test query.').toString('base64')},'fixture');
export const standardSkills=runtimeSkillSetFromFiles(standardSnapshot);
export const standardMetadata={contentDigest:standardSnapshot.digest,loadedSkillMembers:standardSnapshot.members};
export function standardCapabilities(modelId='model'){
  return {schemaVersion:'finance.runtime-capabilities.v1',instanceSchemaVersion:'finance.runtime-instance.v1',
    platform:{os:'linux',arch:'x64',isolation:'trusted_local_process'},runtime:{type:'openjiuwen',version:'test'},
    models:[{modelId,upstreamModelId:'real'}],defaultModelId:modelId,
    features:{streaming:true,asyncLaunch:true,packagedMcp:true,externalMcp:true,inlineSecrets:true,multiTurn:true},
    limits:{maxSkills:10,maxArchiveBytes:8388608,maxFiles:1000,maxTimeoutMs:900000,maxConcurrentInstances:2}};
}
export const released=(instanceId:string)=>({cleanup:{schemaVersion:'finance.eval-cleanup-observation.v1',instanceId,
  observedAt:new Date().toISOString(),status:'RELEASED',scope:'LAUNCHER_MANAGED_RESOURCES'}});

export const standardExecutionRequirements = {
  platform: {os:'linux' as const,arch:'x64',isolation:'trusted_local_process'},
  features: ['streaming' as const],
  limits: {maxSkills:1,maxFiles:1,maxArchiveBytes:1,maxTimeoutMs:1},
};
