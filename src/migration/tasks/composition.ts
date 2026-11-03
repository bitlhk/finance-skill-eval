import { MigrationActivityStore } from '../infrastructure/migration-activity.js';
import {ObservedRuntime} from '../../evaluation/infrastructure/observed-runtime.js';
import type {ExternalTraceCollector} from '../../evaluation/application/external-traces.js';
import { MigrationTaskService } from './application/task-service.js';
import { FileMigrationTaskRepository } from './infrastructure/task-repository.js';
import { runBundleAgent, judgeBundleCase } from './infrastructure/task-agent.js';
import { createBundleRuntime } from './infrastructure/task-runtime.js';
import { createTaskBuilder } from './infrastructure/task-builder.js';
import {configuredImprovementAgents} from '../../service/improvement-agents.js';
import type {ImprovementAgents} from '../../improvement/application/improvement-agents.js';
import type { EnvironmentStore } from '../../service/environment-store.js';
import type { MigrationSourceAssets, BundleAgent, BundleRuntimeFactory, BundleJudge, MigrationLogger } from './application/task-ports.js';
export function createMigrationTaskService(options: {
  traceCollector?:ExternalTraceCollector;
  root: string; skills: MigrationSourceAssets; environments: EnvironmentStore; managed?: boolean;
  logger?: MigrationLogger; ports?: { agent?: BundleAgent; runtime?: BundleRuntimeFactory; judge?: BundleJudge; improvementAgents?:()=>ImprovementAgents; };
}) {
  const runtime=options.ports?.runtime??createBundleRuntime(options.environments,{managed:options.managed});
  return new MigrationTaskService(new FileMigrationTaskRepository(options.root), options.skills,
    options.ports?.agent ?? runBundleAgent,
    async input=>{const execution=await runtime(input);return {...execution,runtime:options.traceCollector?new ObservedRuntime(execution.runtime,options.traceCollector):execution.runtime};},
    options.ports?.judge ?? judgeBundleCase, options.logger, createTaskBuilder(options.environments, { managed: options.managed }), new MigrationActivityStore(options.root),options.ports?.improvementAgents??configuredImprovementAgents);
}
