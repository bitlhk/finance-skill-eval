import {z} from 'zod';
import type {RuntimeAdapter,RuntimeExecutionRequest} from './adapters.js';
import {fingerprint,runtimeExecutionEvidenceSchema} from './contracts.js';

export const originalServiceSchema=z.strictObject({
  endpoint:z.string().url().refine(value=>{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.hash},'请输入不含账号、密码或片段的 HTTP 服务地址'),
  requestTemplate:z.record(z.unknown()),
  responseFormat:z.enum(['json','text']).default('json'),
  responsePointer:z.string().max(1000).refine(value=>value===''||value.startsWith('/'),'返回字段使用 /data/answer 这样的 JSON Pointer').default(''),
  headers:z.array(z.strictObject({name:z.string().regex(/^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/u),env:z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/u),prefix:z.string().max(100).refine(value=>!/[\r\n]/u.test(value)).default('')})).max(32).default([]),
  timeoutMs:z.number().int().min(1000).max(900000).default(120000),
}).superRefine((value,ctx)=>{
  if(new Set(value.headers.map(h=>h.name.toLowerCase())).size!==value.headers.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:'请求头名称不能重复'});
  if(value.responseFormat==='text'&&value.responsePointer)ctx.addIssue({code:z.ZodIssueCode.custom,message:'纯文本响应不需要填写返回字段'});
  if(!JSON.stringify(value.requestTemplate).includes('{{input}}'))ctx.addIssue({code:z.ZodIssueCode.custom,message:'请求模板必须包含 {{input}}，以传入每条测试的任务输入'});
});
export type OriginalServiceConfiguration=z.infer<typeof originalServiceSchema>;
export function originalServiceFingerprint(config:OriginalServiceConfiguration){return fingerprint(originalServiceSchema.parse(config));}
export function mapOriginalServiceRequest(value:unknown,request:RuntimeExecutionRequest):unknown{
  if(typeof value==='string')return value.replace(/\{\{(input|caseId)\}\}/gu,(_whole,key:string)=>key==='input'?request.evalCase.prompt:request.evalCase.caseId);
  if(Array.isArray(value))return value.map(item=>mapOriginalServiceRequest(item,request));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,mapOriginalServiceRequest(item,request)]));
  return value;
}
export function originalServiceResponse(value:unknown,pointer:string):unknown{
  if(!pointer)return value;
  let selected=value;
  for(const part of pointer.slice(1).split('/')){
    const key=part.replaceAll('~1','/').replaceAll('~0','~');
    if(!selected||typeof selected!=='object'||!Object.hasOwn(selected,key))throw Error('原服务响应中不存在配置的返回字段，请检查响应映射');
    selected=(selected as Record<string,unknown>)[key];
  }
  return selected;
}

/** A business-service baseline, without pretending to load or attest its original Runtime. */
export class OriginalServiceRuntimeAdapter implements RuntimeAdapter{
  readonly adapterId='original-service';
  private readonly config:OriginalServiceConfiguration;
  constructor(config:OriginalServiceConfiguration,private readonly sourceDigest:string){this.config=originalServiceSchema.parse(config)}
  async execute(request:RuntimeExecutionRequest){
    const started=Date.now();
    const secrets:string[]=[];
    const redact=(text:string)=>secrets.reduce((output,secret)=>secret?output.replaceAll(secret,'[redacted]'):output,text);
    const signal=AbortSignal.any([...(request.signal?[request.signal]:[]),AbortSignal.timeout(this.config.timeoutMs)]);
    let status:'completed'|'failed'='failed',output='',error:string|null=null;
    try{
      signal.throwIfAborted();
      const headers:Record<string,string>={'content-type':'application/json'};
      for(const header of this.config.headers){
        const value=process.env[header.env];
        if(!value)throw Error(`原服务请求头缺少环境变量：${header.env}`);
        secrets.push(value,header.prefix+value);
        if(/[\r\n]/u.test(value))throw Error('原服务请求头环境变量包含无效字符');
        headers[header.name]=header.prefix+value;
      }
      request.onEvent?.({type:'status',caseId:request.evalCase.caseId,side:request.side,text:'正在调用原服务获取同题基线'});
      const response=await fetch(this.config.endpoint,{method:'POST',headers,body:JSON.stringify(mapOriginalServiceRequest(this.config.requestTemplate,request)),signal,redirect:'error'});
      if(!response.ok)throw Error(`原服务调用失败：HTTP ${response.status}`);
      const reader=response.body?.getReader();let bytes=0;const chunks:Uint8Array[]=[];
      if(reader)try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>2*1024*1024){await reader.cancel();throw Error('原服务响应超过 2 MB')}chunks.push(chunk.value)}}finally{reader.releaseLock()}
      const body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
      let selected:unknown=body;
      if(this.config.responseFormat==='json'){
        let parsed:unknown;try{parsed=JSON.parse(body)}catch{throw Error('原服务未返回有效 JSON，请检查响应格式')}
        selected=originalServiceResponse(parsed,this.config.responsePointer);
      }
      output=redact(typeof selected==='string'?selected:JSON.stringify(selected));
      if(!output.trim())throw Error('原服务映射后的回答为空');
      status='completed';
    }catch(cause){
      request.signal?.throwIfAborted();
      error=signal.aborted?'原服务调用超时':redact(cause instanceof Error?cause.message:'原服务调用失败');
    }
    return runtimeExecutionEvidenceSchema.parse({runId:request.runId,caseId:request.evalCase.caseId,side:request.side,status,output,error,
      modelId:'original-service',skillVersion:null,elapsedMs:Date.now()-started,runtimeIdentityVerified:false,streamCompleted:status==='completed',
      metadata:{baselineService:{configurationFingerprint:originalServiceFingerprint(this.config),sourceDigest:this.sourceDigest,sourceAssociation:'USER_DECLARED',responseDigest:status==='completed'?fingerprint(output):null}}});
  }
}
