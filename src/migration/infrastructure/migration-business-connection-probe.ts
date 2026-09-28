import type {MigrationBusinessConnectionProbe} from '../application/migration-business-connection-probe.js';

/** No response bodies or server error messages are retained; they may contain credentials. */
export async function probeBusinessInterface(url:string,method:'GET'|'HEAD',headers:Record<string,string>,signal?:AbortSignal){
  const endpoint=new URL(url);if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password)throw Object.assign(new Error('请提供不包含账号密码的 HTTP 接口地址'),{statusCode:400});
  try{const response=await fetch(endpoint,{method,headers,redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});await response.body?.cancel();const passed=response.ok;return {status:passed?'PASSED' as const:'FAILED' as const,httpStatus:response.status,message:passed?'业务接口返回成功；尚未验证迁移工具与业务结果。':`业务接口返回 HTTP ${response.status}；未跟随重定向。`}}catch{return {status:'FAILED' as const,message:signal?.aborted?'连通验证已取消。':'接口连接失败或超时，请检查地址、网络与测试配置。'} }
}

export class HttpMigrationBusinessConnectionProbe implements MigrationBusinessConnectionProbe {
  probe(url:string,method:'GET'|'HEAD',headers:Record<string,string>,signal?:AbortSignal){return probeBusinessInterface(url,method,headers,signal);}
}
