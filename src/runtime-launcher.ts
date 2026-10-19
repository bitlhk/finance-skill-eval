import { conversationTurnsSchema,fingerprint, runtimeExecutionEvidenceSchema, workspaceFilesDigest, workspaceFilesSchema, type ModelRef, type RuntimeExecutionEvidence, type SkillVariant } from './contracts.js';
import {canonicalSha256} from './shared/json-canonicalization.js';
import type { EvaluationSide, RuntimeAdapter, RuntimeExecutionRequest, RuntimePrepareContext } from './adapters.js';
import { RuntimeCaseNotExecutedError, RuntimeExecutionFailure } from './adapters.js';
import type { ResolvedSkillSource } from './direct-model-runtime.js';
import type { RuntimeEnvironmentDescriptor } from './http-runtime.js';
import { runtimeCleanupObservationSchema, runtimeLauncherBaseUrlSchema, runtimeLauncherCapabilitiesSchema } from './shared/contracts/runtime-launcher.js';
import { runtimeObservationEventSchema, type RuntimeObservationEvent } from './shared/contracts/runtime-observation.js';
import { z } from 'zod';
import {runtimeBundleSchema,type RuntimeBundle} from './shared/contracts/runtime-bundle.js';

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
  turns:conversationTurnsSchema.optional(),
});

export type RuntimeInstanceSecrets={mode:'inline';values:Record<string,string>};
export const launcherGenerationSchema=z.strictObject({
  schemaVersion:z.literal('finance.eval-generation.v1'),
  temperature:z.number().finite().min(0).max(2),
  top_p:z.number().finite().gt(0).max(1),
  max_tokens:z.number().int().min(1).max(32768),
  thinking:z.strictObject({type:z.literal('disabled')}).optional(),
});
export type RuntimeInstanceRequest={
  schemaVersion:'finance.skill-eval.runtime-instance.v1'|'finance.skill-eval.runtime-instance.v2';runId:string;side:EvaluationSide;modelId:string;
  bundle?:RuntimeBundle;
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
export function runtimeLauncherErrorMessage(code:string):string{
  const messages:Record<string,string>={
    EVAL_RUNTIME_QUALIFICATION_REQUIRED:'此 Runtime 缺少准入材料，请 Builder 管理者生成并配置原生运行与可观测性资格证明。',
    EVAL_RUNTIME_QUALIFICATION_REJECTED:'此 Runtime 的准入材料与当前源码、产物或观测要求不匹配，请 Builder 管理者重新验证。',
    EVAL_ASSET_DIRECTORY_CHANGED:'Builder 的资产目录已更新，请刷新运行配置后重新验证。',
    EVAL_BUILD_PREFLIGHT_FAILED:'Builder 构建预检未通过，请检查工具链、模板和依赖配置。',
  };
  return messages[code]?`${messages[code]}（${code}）`:code;
}
function launcherPayloadError(status:number,payload:unknown):Error{
  const value=payload as {error?:unknown}|null;
  const code=typeof value?.error==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(value.error)?value.error:null;
  return new Error(`Runtime Launcher HTTP ${status}${code?`: ${runtimeLauncherErrorMessage(code)}`:''}`);
}
export async function runtimeLauncherResponseError(response:Response):Promise<Error>{
  return launcherPayloadError(response.status,await readBoundedJson(response,65536,'Runtime Launcher error').catch(()=>null));
}
const responseError=runtimeLauncherResponseError;
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
export type RuntimeObservationSummary={sequence:number;kind:RuntimeObservationEvent['kind'];nativeEventType?:string;synthesized:boolean;
  toolCallId?:string;toolName?:string;modelCallId?:string;modelId?:string;inputDigest?:string;outputDigest?:string;durationMs?:number;errorCode?:string};
/** Keep causal identifiers and digests, never raw prompts, outputs, arguments or native data. */
export function summarizeRuntimeObservation(event:RuntimeObservationEvent):RuntimeObservationSummary|null{
  if(event.kind==='output.delta')return null;
  const payload=event.payload as Record<string,unknown>;
  const summary:RuntimeObservationSummary={sequence:event.sequence,kind:event.kind,synthesized:event.source.synthesized};
  if(event.source.nativeEventType)summary.nativeEventType=event.source.nativeEventType;
  for(const [key,target] of [['toolCallId','toolCallId'],['name','toolName'],['modelCallId','modelCallId'],['modelId','modelId'],['inputDigest','inputDigest'],['outputDigest','outputDigest']] as const){
    if(typeof payload[key]==='string')(summary as unknown as Record<string,unknown>)[target]=payload[key];
  }
  if(typeof payload.durationMs==='number')summary.durationMs=payload.durationMs;
  const error=payload.error;
  if(error&&typeof error==='object'&&'code' in error&&typeof error.code==='string')summary.errorCode=error.code;
  return summary;
}
async function readExecution(response:Response,request:RuntimeExecutionRequest,instanceId:string):Promise<{payload:unknown;observations:RuntimeObservationSummary[];observationsTruncated:boolean}>{
  if(!response.headers.get('content-type')?.includes('text/event-stream'))return {payload:await readBoundedJson(response,RUNTIME_LAUNCHER_STREAM_LIMITS.evidenceBytes,'Runtime Launcher evidence'),observations:[],observationsTruncated:false};
  if(!response.body)throw new Error('Runtime instance stream is empty');
  const reader=response.body.getReader(),decoder=new TextDecoder();let value:unknown;const observations:RuntimeObservationSummary[]=[];let observationsTruncated=false;
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
        const parsed=runtimeObservationEventSchema.parse(event),summary=summarizeRuntimeObservation(parsed);
        if((parsed.runId!==undefined&&parsed.runId!==request.runId)
          ||(parsed.caseId!==undefined&&parsed.caseId!==request.evalCase.caseId)
          ||(parsed.side!==undefined&&parsed.side!==request.side)||parsed.instanceId!==instanceId)
          throw new Error('Runtime observation does not match the requested case');
        if(summary){if(observations.length<64)observations.push(summary);else observationsTruncated=true;}
        forwardObservation(parsed,request);
        if(parsed.kind==='execution.failed'){
          const code=parsed.payload.error?.code;
          const metadata:Record<string,unknown>={instanceId,launcherTraceId:parsed.traceId};
          if(parsed.source.adapter==='finance-solution-builder'&&parsed.source.nativeEventType==='builder.execution-correlation.v1'){
            const fields=parsed.native?.data as Record<string,unknown>|undefined;
            const diagnostic=Object.fromEntries(['buildId','hostInstanceId','hostRunId','hostTraceId']
              .filter(key=>typeof fields?.[key]==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u.test(fields[key] as string))
              .map(key=>[key,fields![key]]));
            if(Object.keys(diagnostic).length)metadata.launcherDiagnostics={basis:'LAUNCHER_CORRELATION_NOT_EXECUTION_VERIFICATION',...diagnostic};
          }
          throw new RuntimeExecutionFailure(`Runtime execution failed: ${code&&/^[A-Z][A-Z0-9_]{0,119}$/u.test(code)?code:'EXECUTION_FAILED'}`,metadata);
        }
      }
      else if(typeof event.type==='string'&&['status','text_delta','tool_start','tool_end'].includes(event.type))request.onEvent?.({...event,caseId:request.evalCase.caseId,side:request.side} as never);
    }
  }finally{await reader.cancel().catch(()=>undefined);}
  if(!value)throw new Error('Runtime instance stream ended without execution evidence');
  return {payload:value,observations,observationsTruncated};
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
  private cleanupObservation:Record<string,unknown>={status:'NOT_REQUESTED'};
  private readonly cleanupReceipts=new Map<string,Record<string,unknown>>();
  finalizationEvidence(){
    const instances=[...this.cleanupReceipts.values()].map(receipt=>({...receipt}));
    return instances.length<=1?{...this.cleanupObservation}:{status:instances.every(receipt=>receipt.status==='RELEASED')?'RELEASED':'UNKNOWN',scope:'ALL_CREATED_INSTANCES',instances};
  }
  private executeUrl:URL|null=null;
  private incarnation=0;
  private recoveryRequired=false;
  private executionTail:Promise<void>=Promise.resolve();
  private generation:z.infer<typeof launcherGenerationSchema>|undefined;
  private failedCaseId:string|null=null;
  constructor(private readonly options:{baseUrl:string;headers?:Record<string,string>;side:EvaluationSide;model:ModelRef;variant:SkillVariant;
    skill:ResolvedSkillSource|null;bundle?:RuntimeBundle;environment:RuntimeEnvironmentDescriptor;configuration?:Record<string,string>;secrets?:RuntimeInstanceSecrets;timeoutMs:number;requireStatusPoll?:boolean;stopAfterFailure?:boolean}){
    this.options.baseUrl=runtimeLauncherBaseUrlSchema.parse(options.baseUrl);this.adapterId=`runtime-launcher:${new URL(this.options.baseUrl).origin}:${options.side}`;
  }
  async prepare(context:RuntimePrepareContext):Promise<void>{
    const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(this.options.timeoutMs)]) : AbortSignal.timeout(this.options.timeoutMs);
    const extracted=extractSecrets(this.options.environment,this.options.secrets);
    if(this.options.bundle){
      runtimeBundleSchema.parse(this.options.bundle);
      if(this.options.skill)throw new Error('Bundle instances cannot contain a separate single Skill');
      const response=await fetch(endpoint(this.options.baseUrl,'v1/runtime-capabilities'),{headers:this.options.headers,redirect:'error',signal});
      if(!response.ok||runtimeLauncherCapabilitiesSchema.parse(await response.json()).features.multiSkill!==true)throw new Error('目标 Runtime 未声明多 Skill 装载能力');
    }
    const parameters=this.options.model.parameters;
    const generation=Object.keys(parameters).length
      ? {...launcherGenerationSchema.omit({schemaVersion:true}).parse(parameters),schemaVersion:'finance.eval-generation.v1' as const} : undefined;
    this.generation=generation;
    const request:RuntimeInstanceRequest={schemaVersion:'finance.skill-eval.runtime-instance.v1',runId:context.runId,side:this.options.side,
      modelId:this.options.model.modelId,variant:this.options.variant,skill:this.options.skill,environment:extracted.environment,
      configuration:this.options.configuration??{},secrets:extracted.secrets,limits:{timeoutMs:this.options.timeoutMs}};
    if(generation)request.generation=generation;
    if(this.options.bundle){request.schemaVersion='finance.skill-eval.runtime-instance.v2';request.bundle=this.options.bundle;}
    const idempotencyKey=fingerprint({runId:context.runId,side:this.options.side,configuration:fingerprint(request),...(this.incarnation?{incarnation:this.incarnation}:{})});
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
    if(this.instance.status!=='ready'||!this.instance.executeEndpoint)throw new Error(runtimeLauncherErrorMessage(this.instance.error??'Runtime instance failed to start'));
    this.executeUrl=controlledUrl(this.options.baseUrl,this.instance.executeEndpoint);
  }
  async execute(request:RuntimeExecutionRequest):Promise<RuntimeExecutionEvidence>{
    // A Launcher may retire an instance after failure. Serialize recovery with case
    // execution; never replay the failed case (it may already have caused side effects).
    const execution=this.executionTail.then(async()=>{
      request.signal?.throwIfAborted();
      if(this.options.stopAfterFailure&&this.failedCaseId)throw new RuntimeCaseNotExecutedError(this.failedCaseId);
      try{
        if(this.recoveryRequired){
          await this.cleanup();
          this.incarnation+=1;
          await this.prepare({runId:request.runId,signal:request.signal});
          this.recoveryRequired=false;
        }
        const evidence=await this.executePrepared(request);
        if(evidence.status==='failed'){this.recoveryRequired=true;this.failedCaseId=request.evalCase.caseId;}
        return evidence;
      }catch(error){this.recoveryRequired=true;this.failedCaseId=request.evalCase.caseId;throw error;}
    });
    this.executionTail=execution.then(()=>undefined,()=>undefined);
    return execution;
  }
  private async executePrepared(request:RuntimeExecutionRequest):Promise<RuntimeExecutionEvidence>{
    if(!this.instance||!this.executeUrl)throw new Error('Runtime instance is not ready');
    if(request.evalCase.turns){
      const capabilities=await fetch(endpoint(this.options.baseUrl,'v1/runtime-capabilities'),{headers:this.options.headers,redirect:'error',signal:request.signal?AbortSignal.any([request.signal,AbortSignal.timeout(this.options.timeoutMs)]):AbortSignal.timeout(this.options.timeoutMs)});
      if(!capabilities.ok||runtimeLauncherCapabilitiesSchema.parse(await capabilities.json()).features.multiTurn!==true)
        throw new Error('所选 Runtime 尚未声明真实多轮续接能力，复用验收未执行');
    }
    const response=await fetch(this.executeUrl,{method:'POST',redirect:'error',signal:request.signal?AbortSignal.any([request.signal,AbortSignal.timeout(this.options.timeoutMs)]):AbortSignal.timeout(this.options.timeoutMs),
      headers:{'content-type':'application/json',...this.options.headers},body:JSON.stringify(runtimeCaseRequestSchema.parse({schemaVersion:'finance.skill-eval.runtime-case.v1',caseId:request.evalCase.caseId,query:request.evalCase.prompt,requiredTools:request.evalCase.requiredTools,workspaceFiles:request.evalCase.workspaceFiles??[],...(request.evalCase.turns?{turns:request.evalCase.turns}:{})}))});
    if(!response.ok)throw await responseError(response);
    const execution=await readExecution(response,request,this.instance.instanceId),payload=execution.payload;
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
    if(this.options.bundle){
      const bundle=this.options.bundle;
      const observed=z.array(z.object({id:z.string(),skillId:z.string(),version:z.string(),artifactSha256:z.string(),skillFile:z.string()})).parse(evidence.metadata.loadedBundleMembers);
      if(evidence.metadata.bundleDigest!==bundle.digest||observed.length!==bundle.members.length
        ||fingerprint([...observed].sort((a,b)=>a.id.localeCompare(b.id)))!==fingerprint([...bundle.members].sort((a,b)=>a.id.localeCompare(b.id)))
        ||bundle.members.some(member=>!evidence.loadedSkills.some(item=>item.skillId===member.skillId&&item.version===member.version)))
        throw new Error('整组 Skill 装载清单或内容摘要与本次候选不一致');
    }
    if(this.options.skill&&!evidence.loadedSkills.some(item=>item.skillId===this.options.skill!.skillId&&item.version===this.options.skill!.version))throw new Error('Runtime instance did not load the requested Skill artifact');
    if(this.options.variant.mode==='without_target_skill'&&evidence.loadedSkills.some(item=>item.skillId===this.options.variant.skillId))throw new Error('Baseline Runtime instance unexpectedly loaded the target Skill');
    if(evidence.metadata.instanceConfigurationDigest!==this.instance.configurationDigest)throw new Error('Runtime instance evidence has a different configuration digest');
    const expectedWorkspaceDigest=request.evalCase.workspaceFiles?.length?workspaceFilesDigest(request.evalCase.workspaceFiles):null;
    if((evidence.metadata.workspaceFilesDigest??null)!==expectedWorkspaceDigest)throw new Error('Runtime instance did not mount the requested test data');
    if(request.evalCase.turns){
      const receipt=z.strictObject({sessionId:z.string().min(1),workspaceId:z.string().min(1),
        turns:z.array(z.strictObject({index:z.number().int().nonnegative(),queryDigest:z.string(),status:z.enum(['completed','failed']),
          outputDigest:z.string(),output:z.string(),toolNames:z.array(z.string())}))}).parse(evidence.metadata.conversation);
      if((evidence.status==='completed'?receipt.turns.length!==request.evalCase.turns.length:receipt.turns.length>request.evalCase.turns.length)||receipt.turns.some((turn,index)=>turn.index!==index
        ||turn.queryDigest!==canonicalSha256(request.evalCase.turns![index]!.query)||turn.status!=='completed'
        ||turn.outputDigest!==canonicalSha256(turn.output)
        ||request.evalCase.turns![index]!.requiredTools.some(name=>!turn.toolNames.includes(name))))
        throw new Error('Runtime conversation evidence does not match the real requested turns');
      if(evidence.status==='completed'&&evidence.output!==receipt.turns.map((t,i)=>`Turn ${i+1}:\n${t.output}`).join('\n\n'))throw new Error('Runtime conversation output evidence does not match');
      // A completed conversation must account for every successful call exactly
      // once, including repeated calls. A failed turn may have an unreceipted tail.
      if(evidence.status==='completed'){
        const recorded=receipt.turns.flatMap(turn=>turn.toolNames).sort();
        const executed=evidence.toolCalls.filter(call=>call.status==='completed').map(call=>call.name).sort();
        if(fingerprint(recorded)!==fingerprint(executed))throw new Error('Runtime conversation tool receipts do not match execution evidence');
      }
    }
    return {...evidence,traceFingerprint:evidence.traceFingerprint??fingerprint(evidence),metadata:{...evidence.metadata,executionMode:'runtime-launcher',runtimeEndpoint:new URL(this.options.baseUrl).origin,instanceId:this.instance.instanceId,
      observationSummary:execution.observations,observationSummaryTruncated:execution.observationsTruncated}};
  }
  async cleanup():Promise<void>{
    const instance=this.instance;if(!instance)return;
    this.cleanupObservation={status:'REQUESTED',instanceId:instance.instanceId};
    try{
    for(let attempt=0;attempt<10;attempt++){
      let response:Response;
      try{response=await fetch(endpoint(this.options.baseUrl,`v1/runtime-instances/${encodeURIComponent(instance.instanceId)}`),{method:'DELETE',headers:this.options.headers,redirect:'error',signal:AbortSignal.timeout(10_000)});}
      catch(error){this.cleanupObservation={status:'REQUEST_FAILED',instanceId:instance.instanceId};throw error;}
      const payload=await readBoundedJson(response,65536,'Cleanup receipt').catch(()=>null) as {cleanup?:unknown}|null;
      const parsed=runtimeCleanupObservationSchema.safeParse(payload?.cleanup);
      if(parsed.success&&parsed.data.instanceId===instance.instanceId){
        this.cleanupObservation=parsed.data;
      }else this.cleanupObservation={status:'UNKNOWN',instanceId:instance.instanceId,httpStatus:response.status,reason:'NO_RESOURCE_RECEIPT'};
      if(!response.ok&&response.status!==404){
        if(!parsed.success||parsed.data.instanceId!==instance.instanceId)this.cleanupObservation={status:'REQUEST_FAILED',instanceId:instance.instanceId};
        throw launcherPayloadError(response.status,payload);
      }
      if(parsed.success&&parsed.data.instanceId===instance.instanceId&&parsed.data.status==='PENDING'&&attempt<9){await new Promise(resolve=>setTimeout(resolve,200));continue;}
      break;
    }
    this.instance=null;this.executeUrl=null;
    }finally{this.cleanupReceipts.set(instance.instanceId,{...this.cleanupObservation});}
  }
}
