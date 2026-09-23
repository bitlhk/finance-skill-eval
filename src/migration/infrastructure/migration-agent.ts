/** Compatibility exports. New composition code imports the focused modules directly. */
export {analyzeWithAgent,implementWithAgent} from './migration-agent-gateway.js';
export {AgentResultMapper,contractSample,toGeneratedImplementations,toProjectInspection,toSkillDocumentDelivery} from './migration-agent-result-mapper.js';
export {
  MigrationAgentUnavailable,
  agentIterations,
  agentMaxTokens,
  encodeArchive,
  migrationAgentEnabled,
  runMigrationAgent,
} from './migration-agent-runner.js';
export type {AgentPayload,AgentResult,AgentStage,AgentStatus,MigrationAgentOptions} from './migration-agent-runner.js';
