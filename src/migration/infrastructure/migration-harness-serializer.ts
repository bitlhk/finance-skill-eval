import { stringify } from 'yaml';
import type { ProjectInspection } from '../domain/migration-model.js';
import { runtimeBuildRequirements } from '../domain/migration-harness.js';
import type { MigrationHarnessSerializer } from '../application/migration-harness-serializer.js';

export function runtimeBuildRequirementsYaml(inspection: ProjectInspection, runtimeType='openjiuwen'): string | null {
  const requirements = runtimeBuildRequirements(inspection,{runtimeType});
  return requirements ? stringify(requirements, { lineWidth: 0 }) : null;
}

export class YamlMigrationHarnessSerializer implements MigrationHarnessSerializer {
  serialize(inspection:ProjectInspection,runtimeType?:string){
    return runtimeBuildRequirementsYaml(inspection,runtimeType);
  }
}
