import type { Dependency } from '../domain/migration-dependency.js';

export type ConnectionCheck={id:string;toolId:string;kind:'BUSINESS_INTERFACE'|'GENERATED_TOOL'|'SOURCE_TOOL';status:'PASSED'|'FAILED';configurationDigest:string;assetDigest:string;checkedAt:string;message:string;httpStatus?:number;validationId?:string};
export type RuntimeTestConfig={revision:number;values:Record<string,unknown>;checks:ConnectionCheck[]};

export interface MigrationRuntimeConfigurationRepository {
  get(migrationId:string):Promise<RuntimeTestConfig>;
  save(migrationId:string,dependency:Dependency,value:unknown,revision:number):Promise<RuntimeTestConfig>;
  check(migrationId:string,result:Omit<ConnectionCheck,'id'|'checkedAt'>):Promise<ConnectionCheck>;
}
