import { fingerprint } from '../../contracts.js';
import type { Dependency } from './migration-dependency.js';

export type ConnectionCheck={id:string;toolId:string;kind:'BUSINESS_INTERFACE'|'GENERATED_TOOL'|'SOURCE_TOOL';status:'PASSED'|'FAILED';configurationDigest:string;assetDigest:string;checkedAt:string;message:string;httpStatus?:number;validationId?:string};
export type RuntimeTestConfig={revision:number;values:Record<string,unknown>;checks:ConnectionCheck[]};

export const configurationDigest=(config:RuntimeTestConfig,dependencies:Dependency[]=[])=>
  fingerprint([config.revision,config.values,dependencies]);
