import type { ExecutionConfiguration,ExecutionConfigurationCheck,ExecutionConfigurationRepository } from '../../execution-configuration/execution-configuration.js';

export type ConnectionCheck=ExecutionConfigurationCheck&{toolId:string;kind:'BUSINESS_INTERFACE'|'GENERATED_TOOL'|'SOURCE_TOOL'};
export type RuntimeTestConfig=ExecutionConfiguration<ConnectionCheck>;
export type MigrationRuntimeConfigurationRepository=ExecutionConfigurationRepository<ConnectionCheck>;
