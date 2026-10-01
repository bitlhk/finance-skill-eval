import { fingerprint, runtimeExecutionEvidenceSchema, workspaceFilesDigest, workspaceFilesSchema, type ModelRef, type RuntimeExecutionEvidence, type SkillVariant } from './contracts.js';
import type { EvaluationSide, RuntimeAdapter, RuntimeExecutionRequest, RuntimePrepareContext } from './adapters.js';
import { RuntimeCaseNotExecutedError } from './adapters.js';
import type { ResolvedSkillSource } from './direct-model-runtime.js';
import type { RuntimeEnvironmentDescriptor } from './http-runtime.js';
import { runtimeLauncherBaseUrlSchema, runtimeLauncherCapabilitiesSchema } from './shared/contracts/runtime-launcher.js';
import { runtimeObservationEventSchema, type RuntimeObservationEvent } from './shared/contracts/runtime-observation.js';
import { z } from 'zod';

export { runtimeLauncherCapabilitiesSchema } from './shared/contracts/runtime-launcher.js';
export type { RuntimeLauncherCapabilities } from './shared/contracts/runtime-launcher.js';

export const runtimeInstanceStateSchema=z.strictObject({
  schemaVersion:z.literal('finance.skill-eval.runtime-instance-state.v1'),instanceId:z.string().min(1),
  status:z.enum(['starting','ready','failed']),executeEndpoint:z.string().min(1).nullable().default(null),
  expiresAt:z.string().datetime(),error:z.string().nullable().default(null),configurationDigest:z.string().min(1),
});
type InstanceState=z.infer<typeof runtimeInstanceStateSchema>;
export const runtimeCaseRequestSchema=z.strictObject({
  schemaVersion:z.literal('finance.skill-eval.runtime-case.v1'),caseId:z.string().min(1),query:z.string().min(1),
  requiredTools:z.array(z.string().min(1)),workspaceFiles:workspaceFilesSchema,
});

export type RuntimeInstanceSecrets={mode:'inline';values:Record<string,string>};
export const launcherGenerationSchema=z.strictObject({
  schemaVersion:z.literal('finance.eval-generation.v1'),
  temperature:z.number().finite().min(0).max(2),
  top_p:z.number().finite().gt(0).max(1),
  max_tokens:z.number().int().min(1).max(32768),
});
export type RuntimeInstanceRequest={
  schemaVersion:'finance.skill-eval.runtime-instance.v1';runId:string;side:EvaluationSide;modelId:string;
  variant:SkillVariant;skill:ResolvedSkillSource|null;environment:RuntimeEnvironmentDescriptor;
  configuration:Record<string,string>;secrets:RuntimeInstanceSecrets;limits:{timeoutMs:number};
  generation?:z.infer<typeof launcherGenerationSchema>;
};

function endpoint(base:string,path:string):URL{return new URL(path,new URL(base));}
export const RUNTIME_LAUNCHER_STREAM_LIMITS={frameBytes:524_288,evidenceBytes:262_144} as const;
function controlledUrl(base:string,value:string):URL{
  const resolved=new URL(value,new URL(base));
  if(resolved.origin!==new URL(base).origin)throw new Error('Runtime Launcher returned a cross-origin endpoint');
  if(!resolved.pathname.startsWith(new URL(base).pathname))throw new Error('Runtime Launcher endpoint escaped its registered base path');
  return resolved;
}
function extractSecrets(source:RuntimeEnvironmentDescriptor,provided:RuntimeInstanceSecrets|undefined){
  const environment=structuredClone(source),values:Record<string,string>={...(provided?.values??{})};
  for(const [index,service] of (environment.mcpServers??[]).entries()){
    const bindings:Record<string,string>={};
    for(const [name,value] of Object.entries(service.secretHeaders??{})){const key=`external-mcp.${index}.${name}`;values[key]=value;bindings[name]=key;}
    delete service.secretHeaders;if(Object.keys(bindings).length)service.secretBindings=bindings;
  }
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
function serializedBytes(value:unknown):number{return new TextEncoder().encode(JSON.stringify(value)).byteLength;}
export async function readBoundedJson(response:Response,limit:number,label:string):Promise<unknown>{
  if(!response.body)throw new Error(`${label} response body is empty`);
  const declared=Number(response.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>limit)throw new Error(`${label} exceeds ${limit} bytes`);
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  try{
    while(true){const chunk=await reader.read();if(chunk.value){total+=chunk.value.byteLength;if(total>limit)throw new Error(`${label} exceeds ${limit} bytes`);chunks.push(chunk.value);}if(chunk.done)break;}
  }finally{await reader.cancel().catch(()=>undefined);}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function* boundedSseFrames(reader:ReadableStreamDefaultReader<Uint8Array>):AsyncGenerator<Uint8Array>{
  let pending:number[]=[];
  while(true){
    const chunk=await reader.read();
    if(chunk.value)for(const byte of chunk.value){
      pending.push(byte);
      const length=pending.length;
      const delimiter=length>=2&&pending[length-2]===10&&pending[length-1]===10?2
        :length>=4&&pending[length-4]===13&&pending[length-3]===10&&pending[length-2]===13&&pending[length-1]===10?4:0;
      if(delimiter){yield Uint8Array.from(pending.slice(0,-delimiter));pending=[];continue;}
      if(pending.length>RUNTIME_LAUNCHER_STREAM_LIMITS.frameBytes)throw new Error(`Runtime Launcher SSE frame exceeds ${RUNTIME_LAUNCHER_STREAM_LIMITS.frameBytes} bytes`);
    }
    if(chunk.done)break;
  }
  if(pending.some(byte=>![9,10,13,32].includes(byte)))throw new Error('Runtime Launcher SSE stream ended with an unfinished frame');
}
async function readExecution(response:Response,request:RuntimeExecutionRequest):Promise<unknown>{
  if(!response.headers.get('content-type')?.includes('text/event-stream'))return readBoundedJson(response,RUNTIME_LAUNCHER_STREAM_LIMITS.evidenceBytes,'Runtime Launcher evidence');
  if(!response.body)throw new Error('Runtime instance stream is empty');
  const reader=response.body.getReader(),decoder=new TextDecoder();let value:unknown;
  try{
    for await(const bytes of boundedSseFrames(reader)){
      const frame=decoder.decode(bytes).replaceAll('\r\n','\n');
      const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if(!data)continue;
      const event=JSON.parse(data) as Record<string,unknown>;
      if(event.evidence){
        if(serializedBytes(event.evidence)>RUNTIME_LAUNCHER_STREAM_LIMITS.evidenceBytes)throw new Error(`Runtime Launcher evidence exceeds ${RUNTIME_LAUNCHER_STREAM_LIMITS.evidenceBytes} bytes`);
        value=event.evidence;
      }else if(event.schemaVersion==='finance.runtime-observation.v1'){
        const observation=runtimeObservationEventSchema.parse(event);
        forwardObservation(observation,request);
        if(observation.kind==='execution.failed'){
          const code=observation.payload.error?.code;
          // Preserve a normalized failure code, never arbitrary upstream message text.
          throw new Error(`Runtime execution failed: ${code&&/^[A-Z][A-Z0-9_]{0,119}$/u.test(code)?code:'EXECUTION_FAILED'}`);
        }
      }
      else if(typeof event.type==='string'&&['status','text_delta','tool_start','tool_end'].includes(event.type))request.onEvent?.({...event,caseId:request.evalCase.caseId,side:request.side} as never);
    }
  }finally{await reader.cancel().catch(()=>undefined);}
  if(!value)throw new Error('Runtime instance stream ended without execution evidence');
  return value;
}

function forwardObservation(event:RuntimeObservationEvent,request:RuntimeExecutionRequest):void{
  if(!request.onEvent)return;
  if(event.kind==='output.delta')request.onEvent({type:'text_delta',caseId:request.evalCase.caseId,side:request.side,text:event.payload.text});
  else if(event.kind.startsWith('tool.call.'))request.onEvent({type:event.kind==='tool.call.started'?'tool_start':'tool_end',caseId:request.evalCase.caseId,side:request.side,toolName:'name' in event.payload?event.payload.name:undefined,status:event.kind});
  else if(event.kind.startsWith('execution.'))request.onEvent({type:'status',caseId:request.evalCase.caseId,side:request.side,status:event.kind,text:'message' in event.payload?event.payload.message:undefined});
}

export class RuntimeLauncherAdapter implements RuntimeAdapter{
  readonly adapterId:string;
  private instance:InstanceState|null=null;
  private executeUrl:URL|null=null;
  private generation:z.infer<typeof launcherGenerationSchema>|undefined;
  private failedCaseId:string|null=null;
  private caseQueue:Promise<void>=Promise.resolve();
  constructor(private readonly options:{baseUrl:string;headers?:Record<string,string>;side:EvaluationSide;model:ModelRef;variant:SkillVariant;
    skill:ResolvedSkillSource|null;environment:RuntimeEnvironmentDescriptor;configuration?:Record<string,string>;secrets?:RuntimeInstanceSecrets;timeoutMs:number;requireStatusPoll?:boolean}){
    this.options.baseUrl=runtimeLauncherBaseUrlSchema.parse(options.baseUrl);this.adapterId=`runtime-launcher:${new URL(this.options.baseUrl).origin}:${options.side}`;
  }
  async prepare(context:RuntimePrepareContext):Promise<void>{
    const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(this.options.timeoutMs)]) : AbortSignal.timeout(this.options.timeoutMs);
    const extracted=extractSecrets(this.options.environment,this.options.secrets);
    const parameters=this.options.model.parameters;
    const generation=Object.keys(parameters).length
      ? {...launcherGenerationSchema.omit({schemaVersion:true}).parse(parameters),schemaVersion:'finance.eval-generation.v1' as const} : undefined;
    this.generation=generation;
    const request:RuntimeInstanceRequest={schemaVersion:'finance.skill-eval.runtime-instance.v1',runId:context.runId,side:this.options.side,
      modelId:this.options.model.modelId,variant:this.options.variant,skill:this.options.skill,environment:extracted.environment,
      configuration:this.options.configuration??{},secrets:extracted.secrets,limits:{timeoutMs:this.options.timeoutMs}};
    if(generation)request.generation=generation;
    const idempotencyKey=fingerprint({runId:context.runId,side:this.options.side,configuration:fingerprint(request)});
    const response=await fetch(endpoint(this.options.baseUrl,'v1/runtime-instances'),{method:'POST',redirect:'error',signal,
      headers:{'content-type':'application/json','idempotency-key':idempotencyKey,...this.options.headers},body:JSON.stringify(request)});
    if(!response.ok)throw await responseError(response);
    this.instance=runtimeInstanceStateSchema.parse(await response.json());
    const readStatus=async()=>{
      const status=await fetch(endpoint(this.options.baseUrl,`v1/runtime-instances/${encodeURIComponent(this.instance!.instanceId)}`),{headers:this.options.headers,redirect:'error',signal});
      if(!status.ok)throw await responseError(status);
      this.instance=runtimeInstanceStateSchema.parse(await status.json());
    };
    if(this.options.requireStatusPoll&&this.instance.status!=='starting')await readStatus();
    while(this.instance.status==='starting'){
      signal.throwIfAborted();
      await new Promise<void>((resolve,reject)=>{
        const abort=()=>{clearTimeout(timer);reject(signal.reason);};
        const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},250);
        signal.addEventListener('abort',abort,{once:true});
      });
      await readStatus();
    }
    if(this.instance.status!=='ready'||!this.instance.executeEndpoint)throw new Error(this.instance.error??'Runtime instance failed to start');
    this.executeUrl=controlledUrl(this.options.baseUrl,this.instance.executeEndpoint);
  }
  async execute(request:RuntimeExecutionRequest):Promise<RuntimeExecutionEvidence>{
    const previous=this.caseQueue;
    let release!:()=>void;
    this.caseQueue=new Promise<void>(resolve=>{release=resolve;});
    await previous;
    try{
      request.signal?.throwIfAborted();
      if(this.failedCaseId)throw new RuntimeCaseNotExecutedError(this.failedCaseId);
      try{return await this.executeCase(request);}
      catch(error){
        // An unverified outcome may have retired the instance. Never submit another
        // case or automatically replay a possibly completed operation on this side.
        this.failedCaseId=request.evalCase.caseId;
        throw error;
      }
    }finally{release();}
  }
  private async executeCase(request:RuntimeExecutionRequest):Promise<RuntimeExecutionEvidence>{
    if(!this.instance||!this.executeUrl)throw new Error('Runtime instance is not ready');
    const response=await fetch(this.executeUrl,{method:'POST',redirect:'error',signal:request.signal?AbortSignal.any([request.signal,AbortSignal.timeout(this.options.timeoutMs)]):AbortSignal.timeout(this.options.timeoutMs),
      headers:{'content-type':'application/json',...this.options.headers},body:JSON.stringify(runtimeCaseRequestSchema.parse({schemaVersion:'finance.skill-eval.runtime-case.v1',caseId:request.evalCase.caseId,query:request.evalCase.prompt,requiredTools:request.evalCase.requiredTools,workspaceFiles:request.evalCase.workspaceFiles??[]}))});
    if(!response.ok)throw await responseError(response);
    const payload=await readExecution(response,request);
    const evidence=runtimeExecutionEvidenceSchema.parse(payload&&typeof payload==='object'&&'evidence' in payload?(payload as {evidence:unknown}).evidence:payload);
    if(evidence.runId!==request.runId||evidence.side!==request.side||evidence.caseId!==request.evalCase.caseId)throw new Error('Runtime instance evidence does not match the requested case');
    if(evidence.modelId!==this.options.model.modelId)throw new Error('Runtime instance used a different model');
    if(this.generation){
      const {schemaVersion:_,...parameters}=this.generation;
      if(fingerprint(evidence.metadata.declaredModelParameters??null)!==fingerprint(parameters)
          || evidence.metadata.modelGenerationHostVerified!==true)
        throw new Error('Runtime instance did not verify the requested generation configuration');
    }
    if(evidence.status==='failed'&&!evidence.runtimeIdentityVerified)throw new Error(evidence.error??'Runtime instance stopped before producing verified execution evidence');
    if(this.options.skill&&evidence.metadata.skillArtifactSha256!==this.options.skill.artifactSha256)throw new Error('Runtime instance loaded a different Skill digest');
    if(this.options.skill&&!evidence.loadedSkills.some(item=>item.skillId===this.options.skill!.skillId&&item.version===this.options.skill!.version))throw new Error('Runtime instance did not load the requested Skill artifact');
    if(this.options.variant.mode==='without_target_skill'&&evidence.loadedSkills.some(item=>item.skillId===this.options.variant.skillId))throw new Error('Baseline Runtime instance unexpectedly loaded the target Skill');
    if(evidence.metadata.instanceConfigurationDigest!==this.instance.configurationDigest)throw new Error('Runtime instance evidence has a different configuration digest');
    const expectedWorkspaceDigest=request.evalCase.workspaceFiles?.length?workspaceFilesDigest(request.evalCase.workspaceFiles):null;
    if((evidence.metadata.workspaceFilesDigest??null)!==expectedWorkspaceDigest)throw new Error('Runtime instance did not mount the requested test data');
    return {...evidence,traceFingerprint:evidence.traceFingerprint??fingerprint(evidence),metadata:{...evidence.metadata,executionMode:'runtime-launcher',runtimeEndpoint:new URL(this.options.baseUrl).origin,instanceId:this.instance.instanceId}};
  }
  async cleanup():Promise<void>{
    const instance=this.instance;this.instance=null;this.executeUrl=null;if(!instance)return;
    const response=await fetch(endpoint(this.options.baseUrl,`v1/runtime-instances/${encodeURIComponent(instance.instanceId)}`),{method:'DELETE',headers:this.options.headers,redirect:'error',signal:AbortSignal.timeout(10_000)});
    if(!response.ok&&response.status!==404)throw await responseError(response);
  }
}
