import { MigrationActivityStore } from '../infrastructure/migration-activity.js';
import { MigrationTaskService } from './application/task-service.js';
import { FileMigrationTaskRepository } from './infrastructure/task-repository.js';
import { runBundleAgent, judgeBundleCase } from './infrastructure/task-agent.js';
import { createBundleRuntime } from './infrastructure/task-runtime.js';
import { createTaskBuilder } from './infrastructure/task-builder.js';
import type { EnvironmentStore } from '../../service/environment-store.js';
import type { MigrationSourceAssets, BundleAgent, BundleRuntimeFactory, BundleJudge, MigrationLogger } from './application/task-ports.js';
export function createMigrationTaskService(options: {
  root: string; skills: MigrationSourceAssets; environments: EnvironmentStore; managed?: boolean;
  logger?: MigrationLogger; ports?: { agent?: BundleAgent; runtime?: BundleRuntimeFactory; judge?: BundleJudge; };
}) {
  return new MigrationTaskService(new FileMigrationTaskRepository(options.root), options.skills,
    options.ports?.agent ?? runBundleAgent,
    options.ports?.runtime ?? createBundleRuntime(options.environments, { managed: options.managed }),
    options.ports?.judge ?? judgeBundleCase, options.logger, createTaskBuilder(options.environments, { managed: options.managed }), new MigrationActivityStore(options.root));
}
