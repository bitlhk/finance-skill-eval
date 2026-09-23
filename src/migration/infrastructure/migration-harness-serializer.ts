import { stringify } from 'yaml';
import type { ProjectInspection } from '../domain/migration-model.js';
import { runtimeBuildRequirements } from '../domain/migration-harness.js';

export function runtimeBuildRequirementsYaml(inspection: ProjectInspection): string | null {
  const requirements = runtimeBuildRequirements(inspection);
  return requirements ? stringify(requirements, { lineWidth: 0 }) : null;
}
