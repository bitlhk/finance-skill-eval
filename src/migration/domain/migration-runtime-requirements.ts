import { runtimeBuildRequirements, type RuntimeBuildRequirementState } from './migration-harness.js';
import type { MigrationProject } from './migration-project.js';

export function currentRuntimeRequirements(project: MigrationProject,runtimeType='openjiuwen'): RuntimeBuildRequirementState | null {
  const task=[...(project.improvementTasks??[])].reverse().find(item=>(['RUNNING','WAITING_BUILDER','WAITING_CONFIGURATION','REVIEW'].includes(item.status)
    &&[item.baseAssetId,item.bestCandidate.assetId].includes(project.candidate?.assetId??'')
    ||item.status==='ADOPTED'&&item.bestCandidate.assetId===project.candidate?.assetId)&&item.runtimeRequirements);
  if(task?.runtimeRequirements)return task.runtimeRequirements;
  const owned=new Set(project.improvementTasks?.map(item=>item.runtimeRequirements?.requestId));
  const current=project.runtimeRebuilds?.filter(item=>item.candidateDigest===project.candidate?.artifactSha256&&!owned.has(item.requirements.requestId)).at(-1);
  if(current)return current.requirements;
  const inspection=project.sourceInspection??project.inspection;
  return inspection?runtimeBuildRequirements(inspection,{runtimeType,executionRequirements:project.runtimeExecutionRequirements}):null;
}
