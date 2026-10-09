import { fingerprint } from '../contracts.js';

export type ExecutionConfigurationCheck = {
  id:string;
  kind:string;
  status:'PASSED'|'FAILED';
  configurationDigest:string;
  assetDigest:string;
  checkedAt:string;
  message:string;
  httpStatus?:number;
  validationId?:string;
};

export type ExecutionConfiguration<TCheck extends ExecutionConfigurationCheck=ExecutionConfigurationCheck>={
  revision:number;
  values:Record<string,unknown>;
  checks:TCheck[];
  validationInputs?:Record<string,unknown>;
};

export interface ExecutionConfigurationRepository<TCheck extends ExecutionConfigurationCheck=ExecutionConfigurationCheck> {
  get(scopeId:string):Promise<ExecutionConfiguration<TCheck>>;
  saveValue(scopeId:string,key:string,value:unknown,revision:number):Promise<ExecutionConfiguration<TCheck>>;
  appendCheck(scopeId:string,result:Omit<TCheck,'id'|'checkedAt'>):Promise<TCheck>;
  saveValidationInput?(scopeId:string,toolId:string,input:unknown):Promise<void>;
}

export const executionConfigurationDigest=(config:ExecutionConfiguration,contract:unknown=[])=>
  fingerprint([config.revision,config.values,contract]);
