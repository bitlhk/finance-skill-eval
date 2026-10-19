/** Legacy import/constructor for integrations; all tasks execute the unified service. */
import { MigrationTaskService } from '../tasks/application/task-service.js';
import { FileMigrationTaskRepository } from '../tasks/infrastructure/task-repository.js';
import type { MigrationSourceAssets, BundleAgent, BundleRuntimeFactory, BundleJudge, MigrationLogger } from '../tasks/application/task-ports.js';
export class BundleMigrationService extends MigrationTaskService {
  constructor(root: string, skills: MigrationSourceAssets, agent: BundleAgent, runtime: BundleRuntimeFactory, judge: BundleJudge, logger?: MigrationLogger) {
    super(new FileMigrationTaskRepository(root), skills, agent, runtime, judge, logger);
  }
}
