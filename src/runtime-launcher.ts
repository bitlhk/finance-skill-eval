import { fingerprint, runtimeExecutionEvidenceSchema, type ModelRef, type RuntimeExecutionEvidence, type SkillVariant } from './contracts.js';
import type { EvaluationSide, RuntimeAdapter, RuntimeExecutionRequest, RuntimePrepareContext } from './adapters.js';
import type { ResolvedSkillSource } from './direct-model-runtime.js';
import type { RuntimeEnvironmentDescriptor } from './http-runtime.js';
import { z } from 'zod';

const httpBaseUrl=z.string().url().transform(value=>{
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.search)throw new Error('Runtime Launcher base URL is invalid');
  if(url.protocol==='http:'&&!['127.0.0.1','localhost','::1'].includes(url.hostname))throw new Error('Remote Runtime Launcher requires HTTPS');
  if(!url.pathname.endsWith('/'))url.pathname+='/';
  return url.toString();
});
const publicModel=z.strictObject({modelId:z.string().min(1),upstreamModelId:z.string().min(1),label:z.string().min(1).optional()});
export const runtimeLauncherCapabilitiesSchema=z.strictObject({
  schemaVersion:z.literal('finance.skill-eval.runtime-capabilities.v1'),
  runtime:z.strictObject({type:z.string().min(1),version:z.string().min(1)}),
  models:z.array(publicModel).min(1),defaultModelId:z.string().min(1),
  features:z.strictObject({streaming:z.boolean(),asyncLaunch:z.boolean(),packagedMcp:z.boolean(),externalMcp:z.boolean(),inlineSecrets:z.boolean()}),
  limits:z.strictObject({maxArchiveBytes:z.number().int().positive(),maxFiles:z.number().int().positive(),maxTimeoutMs:z.number().int().positive(),maxConcurrentInstances:z.number().int().positive()}),
}).superRefine((value,context)=>{if(!value.models.some(model=>model.modelId===value.defaultModelId))context.addIssue({code:'custom',message:'Default model is not advertised'});});
export type RuntimeLauncherCapabilities=z.infer<typeof runtimeLauncherCapabilitiesSchema>;

const instanceStateSchema=z.strictObject({
  schemaVersion:z.literal('finance.skill-eval.runtime-instance-state.v1'),instanceId:z.string().min(1),
  status:z.enum(['starting','ready','failed']),executeEndpoint:z.string().min(1).nullable().default(null),
  expiresAt:z.string().datetime(),error:z.string().nullable().default(null),configurationDigest:z.string().min(1),
});
type InstanceState=z.infer<typeof instanceStateSchema>;

export type RuntimeInstanceSecrets={mode:'inline';values:Record<string,string>};
export type RuntimeInstanceRequest={
  schemaVersion:'finance.skill-eval.runtime-instance.v1';runId:string;side:EvaluationSide;modelId:string;
  variant:SkillVariant;skill:ResolvedSkillSource|null;environment:RuntimeEnvironmentDescriptor;
  configuration:Record<string,string>;secrets:RuntimeInstanceSecrets;limits:{timeoutMs:number};
};

function endpoint(base:string,path:string):URL{return new URL(path,new URL(base));}
function controlledUrl(base:string,value:string):URL{
  const resolved=new URL(value,new URL(base));
  if(resolved.origin!==new URL(base).origin)throw new Error('Runtime Launcher returned a cross-origin endpoint');
  if(!resolved.pathname.startsWith(new URL(base).pathname))throw new Error('Runtime Launcher endpoint escaped its registered base path');
  return resolved;
}
function extractSecrets(source:RuntimeEnvironmentDescriptor,provided:RuntimeInstanceSecrets|undefined){
  const environment=structuredClone(source),values:Record<string,string>={...(provided?.values??{})};
  for(const [index,service] of (environment.candidateMcpServices??[]).entries()){
    const bindings:Record<string,string>={};
    for(const [name,value] of Object.entries(service.secretEnvironment??{})){const key=`mcp.${index}.${name}`;values[key]=value;bindings[name]=key;}
    delete service.secretEnvironment;if(Object.keys(bindings).length)service.secretBindings=bindings;
  }
  for(const [name,field] of Object.entries(environment.runtimeToolConfig?.context??{})){
    if(!field.sensitive||!Object.prototype.hasOwnProperty.call(field,'value'))continue;
    const key=`context.${name}`,value=field.value;values[key]=typeof value==='string'?value:JSON.stringify(value);field.value={$secret:key};
  }
  return {environment,secrets:{mode:'inline' as const,values}};
}
async function responseError(response:Response):Promise<Error>{const raw=await response.text();return new Error(`Runtime Launcher HTTP ${response.status}: ${raw.slice(0,400)}`);}
async function readExecution(response:Response,request:RuntimeExecutionRequest):Promise<unknown>{
  if(!response.headers.get('content-type')?.includes('text/event-stream'))return response.json();
  if(!response.body)throw new Error('Runtime instance stream is empty');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',value:unknown;
  try{
    while(true){
      const chunk=await reader.read();
      buffer=(buffer+decoder.decode(chunk.value,{stream:!chunk.done})).replaceAll('\r\n','\n');
      let end:number;
      while((end=buffer.indexOf('\n\n'))>=0){
        const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
        const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        if(!data)continue;
        const event=JSON.parse(data) as Record<string,unknown>;
        if(event.evidence)value=event.evidence;
        else if(typeof event.type==='string'&&['status','text_delta','tool_start','tool_end'].includes(event.type))request.onEvent?.({...event,caseId:request.evalCase.caseId,side:request.side} as never);
      }
      if(chunk.done)break;
    }
  }finally{await reader.cancel().catch(()=>undefined);}
  if(!value)throw new Error('Runtime instance stream ended without execution evidence');
  return value;
}

export class RuntimeLauncherAdapter implements RuntimeAdapter{
  readonly adapterId:string;
  private instance:InstanceState|null=null;
  private executeUrl:URL|null=null;
  constructor(private readonly options:{baseUrl:string;headers?:Record<string,string>;side:EvaluationSide;model:ModelRef;variant:SkillVariant;
    skill:ResolvedSkillSource|null;environment:RuntimeEnvironmentDescriptor;configuration?:Record<string,string>;secrets?:RuntimeInstanceSecrets;timeoutMs:number}){
    this.options.baseUrl=httpBaseUrl.parse(options.baseUrl);this.adapterId=`runtime-launcher:${new URL(this.options.baseUrl).origin}:${options.side}`;
  }
  async prepare(context:RuntimePrepareContext):Promise<void>{
    const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(this.options.timeoutMs)]) : AbortSignal.timeout(this.options.timeoutMs);
    const extracted=extractSecrets(this.options.environment,this.options.secrets);
    const request:RuntimeInstanceRequest={schemaVersion:'finance.skill-eval.runtime-instance.v1',runId:context.runId,side:this.options.side,
      modelId:this.options.model.modelId,variant:this.options.variant,skill:this.options.skill,environment:extracted.environment,
      configuration:this.options.configuration??{},secrets:extracted.secrets,limits:{timeoutMs:this.options.timeoutMs}};
    const idempotencyKey=fingerprint({runId:context.runId,side:this.options.side,configuration:fingerprint(request)});
    const response=await fetch(endpoint(this.options.baseUrl,'v1/runtime-instances'),{method:'POST',redirect:'error',signal,
      headers:{'content-type':'application/json','idempotency-key':idempotencyKey,...this.options.headers},body:JSON.stringify(request)});
    if(!response.ok)throw await responseError(response);
    this.instance=instanceStateSchema.parse(await response.json());
    while(this.instance.status==='starting'){
      signal.throwIfAborted();
      await new Promise<void>((resolve,reject)=>{
        const abort=()=>{clearTimeout(timer);reject(signal.reason);};
        const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},250);
        signal.addEventListener('abort',abort,{once:true});
      });
      const status=await fetch(endpoint(this.options.baseUrl,`v1/runtime-instances/${encodeURIComponent(this.instance.instanceId)}`),{headers:this.options.headers,redirect:'error',signal});
      if(!status.ok)throw await responseError(status);this.instance=instanceStateSchema.parse(await status.json());
    }
    if(this.instance.status!=='ready'||!this.instance.executeEndpoint)throw new Error(this.instance.error??'Runtime instance failed to start');
    this.executeUrl=controlledUrl(this.options.baseUrl,this.instance.executeEndpoint);
  }
  async execute(request:RuntimeExecutionRequest):Promise<RuntimeExecutionEvidence>{
    if(!this.instance||!this.executeUrl)throw new Error('Runtime instance is not ready');
    const response=await fetch(this.executeUrl,{method:'POST',redirect:'error',signal:request.signal?AbortSignal.any([request.signal,AbortSignal.timeout(this.options.timeoutMs)]):AbortSignal.timeout(this.options.timeoutMs),
      headers:{'content-type':'application/json',...this.options.headers},body:JSON.stringify({schemaVersion:'finance.skill-eval.runtime-case.v1',caseId:request.evalCase.caseId,query:request.evalCase.prompt,requiredTools:request.evalCase.requiredTools})});
    if(!response.ok)throw await responseError(response);
    const payload=await readExecution(response,request);
    const evidence=runtimeExecutionEvidenceSchema.parse(payload&&typeof payload==='object'&&'evidence' in payload?(payload as {evidence:unknown}).evidence:payload);
    if(evidence.runId!==request.runId||evidence.side!==request.side||evidence.caseId!==request.evalCase.caseId)throw new Error('Runtime instance evidence does not match the requested case');
    if(evidence.modelId!==this.options.model.modelId)throw new Error('Runtime instance used a different model');
    if(evidence.status==='failed'&&!evidence.runtimeIdentityVerified)throw new Error(evidence.error??'Runtime instance stopped before producing verified execution evidence');
    if(this.options.skill&&evidence.metadata.skillArtifactSha256!==this.options.skill.artifactSha256)throw new Error('Runtime instance loaded a different Skill digest');
    if(this.options.skill&&!evidence.loadedSkills.some(item=>item.skillId===this.options.skill!.skillId&&item.version===this.options.skill!.version))throw new Error('Runtime instance did not load the requested Skill artifact');
    if(this.options.variant.mode==='without_target_skill'&&evidence.loadedSkills.some(item=>item.skillId===this.options.variant.skillId))throw new Error('Baseline Runtime instance unexpectedly loaded the target Skill');
    if(evidence.metadata.instanceConfigurationDigest!==this.instance.configurationDigest)throw new Error('Runtime instance evidence has a different configuration digest');
    return {...evidence,traceFingerprint:evidence.traceFingerprint??fingerprint(evidence),metadata:{...evidence.metadata,executionMode:'runtime-launcher',runtimeEndpoint:new URL(this.options.baseUrl).origin,instanceId:this.instance.instanceId}};
  }
  async cleanup():Promise<void>{
    const instance=this.instance;this.instance=null;this.executeUrl=null;if(!instance)return;
    const response=await fetch(endpoint(this.options.baseUrl,`v1/runtime-instances/${encodeURIComponent(instance.instanceId)}`),{method:'DELETE',headers:this.options.headers,redirect:'error',signal:AbortSignal.timeout(10_000)});
    if(!response.ok&&response.status!==404)throw await responseError(response);
  }
}
