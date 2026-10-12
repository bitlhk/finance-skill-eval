import type {RunConfiguration} from './contracts.js';

export function managedWorkspaceOperation(method:string,route:string,options:{migrationSandboxEnabled?:boolean}={}){
  if(['GET','HEAD','OPTIONS'].includes(method))return true;
  if(route==='/api/environments'||/^\/api\/environments\/[^/]+$/u.test(route))return false;
  if(/^\/api\/migrations\/[^/]+\/validate\/technical$/u.test(route))return Boolean(options.migrationSandboxEnabled);
  return !/^\/api\/migrations\/[^/]+\/check-business-connection$/u.test(route);
}

export function requireManagedRun(configuration:RunConfiguration){
  if(configuration.originalService||configuration.runtimeToolConfig
    ||configuration.runtimeHarnessTools?.length
    ||Object.values(configuration.runtimeCommandBindings??{}).some(values=>values.length)
    ||Object.values(configuration.runtimeMcpBindings??{}).some(values=>values.length))
    throw Object.assign(new Error('此入口仅执行平台已准入的工具；自定义服务、脚本和进程需要单独审核。'),
      {statusCode:403,code:'MANAGED_EXECUTION_REQUIRED'});
}
