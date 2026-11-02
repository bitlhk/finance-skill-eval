import {executionConfigurationDigest} from './execution-configuration.js';
import {serviceEnvironment} from '../migration/domain/migration-runtime-rules.js';
import {readHistoricalMigrationRecord} from './historical-migration-record.js';
import {FileExecutionConfigurationRepository} from './file-execution-configuration-repository.js';

/** Read-only compatibility for service bindings in stored evaluation configurations.
 * This does not instantiate or resume the retired migration workflow. */
export function createHistoricalServiceEnvironmentResolver(root:string){
  const configurations=new FileExecutionConfigurationRepository(root,'migration-runtime-config',id=>/^migration-[a-f0-9-]+$/u.test(id));
  return async(reference:{migrationId:string;revision:number;assetDigest:string;configurationDigest:string},toolNames:string[])=>{
    const project=await readHistoricalMigrationRecord(root,reference.migrationId),config=await configurations.get(reference.migrationId);
    const dependencies=project.sourceInspection?.dependencyAnalysis?.dependencies??[];
    const conflict=(message:string):never=>{throw Object.assign(new Error(message),{statusCode:409});};
    if(!project.candidate||project.candidate.artifactSha256!==reference.assetDigest||config.revision!==reference.revision
      ||executionConfigurationDigest(config,dependencies)!==reference.configurationDigest)conflict('服务配置或候选已变化，请重新验证');
    const tools=project.inspection?.tools??[];
    if(toolNames.some(name=>!tools.some(tool=>tool.name===name)))conflict('服务配置关联了未知工具');
    const toolIds=tools.filter(tool=>toolNames.includes(tool.name)).map(tool=>tool.toolId);
    const selected=dependencies.filter(dependency=>dependency.toolIds.some(id=>toolIds.includes(id)));
    const resolved=serviceEnvironment(selected,config.values);
    const secretNames=new Set(selected.filter(dependency=>dependency.sensitive&&dependency.binding?.kind==='SERVICE_ENV').map(dependency=>dependency.binding!.name));
    return {configuration:Object.fromEntries(Object.entries(resolved).filter(([name])=>!secretNames.has(name))),
      secrets:Object.fromEntries(Object.entries(resolved).filter(([name])=>secretNames.has(name)))};
  };
}
