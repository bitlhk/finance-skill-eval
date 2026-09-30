import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { modelTimeoutMs,type ModelRole } from '../../service/config.js';
import { stageEnvelope,type StageEnvelope } from '../domain/migration-stage-envelope.js';

export type AgentStage='A2'|'A4';
export type AgentStatus='PRODUCED'|'ABSTAINED'|'FAILED';

type WireResult<T>={
  workspaceRoot?:string;
  libraryInventory?:import('../domain/migration-dependency.js').RuntimeLibraryInventory;
  assetDigest?:string;
  status?:string;
  payload?:T;
  files?:Record<string,string>;
  scanner?:Record<string,unknown>|null;
  trace?:{rounds:Array<Record<string,unknown>>};
  elapsedMs?:number;
  modelId?:string;
  error?:string;
  rawOutput?:string;
};

export type AgentPayload<T>={
  judgement:T;
  workspaceRoot?:string;
  libraryInventory?:import('../domain/migration-dependency.js').RuntimeLibraryInventory;
  files?:Record<string,string>;
  scanner?:Record<string,unknown>|null;
};

export type AgentResult<T=Record<string,unknown>>=StageEnvelope<AgentPayload<T>>;

export type MigrationAgentOptions={
  projectRoot:string;
  modelId:string;
  providerId?:string;
  maxIterations?:number;
  maxTokens?:number;
  modelTimeoutMs?:number;
  signal?:AbortSignal;
  timeoutMs?:number;
};

const ENTRY:Record<AgentStage,string>={
  A2:path.join('integrations','openjiuwen','analyze_agent.py'),
  A4:path.join('integrations','openjiuwen','migrate_agent.py'),
};
const STAGE_ROLE:Record<AgentStage,ModelRole>={A2:'ANALYZER',A4:'MIGRATION'};

function failureReason(wire:WireResult<unknown>,produced:boolean):string{
  const said=String(wire.error??'').trim();
  if(said||produced)return said;
  const tail=String(wire.rawOutput??'').trim().slice(-600);
  return tail?`agent 没有说明失败原因，它的原始输出末尾是：${tail}`:'';
}

export function agentIterations(stage:AgentStage):number{
  const configured=Number(process.env.FINANCE_EVAL_AGENT_MAX_ITERATIONS);
  if(Number.isFinite(configured)&&configured>0)return Math.floor(configured);
  return stage==='A2'?60:120;
}

export function agentMaxTokens(stage:AgentStage):number{
  for(const name of [`FINANCE_EVAL_${STAGE_ROLE[stage]}_MAX_TOKENS`,'FINANCE_EVAL_AGENT_MAX_TOKENS']){
    const configured=Number(process.env[name]);
    if(Number.isFinite(configured)&&configured>0)return Math.floor(configured);
  }
  return 32_000;
}

export class MigrationAgentUnavailable extends Error{
  constructor(message:string){super(message);this.name='MigrationAgentUnavailable'}
}

export function migrationAgentEnabled():boolean{
  const flag=process.env.FINANCE_EVAL_MIGRATION_AGENT?.trim().toLowerCase();
  if(flag==='off')return false;
  if(flag==='on')return true;
  return !process.env.VITEST;
}

function interpreter(projectRoot:string):string{
  const configured=process.env.FINANCE_EVAL_MIGRATION_PYTHON?.trim();
  if(configured)return configured;
  return process.platform==='win32'
    ?path.join(projectRoot,'.venv-openjiuwen','Scripts','python.exe')
    :path.join(projectRoot,'.venv-openjiuwen','bin','python');
}

export function encodeArchive(archive:Record<string,Uint8Array>):Record<string,string>{
  return Object.fromEntries(Object.entries(archive).map(([name,bytes])=>[name,Buffer.from(bytes).toString('base64')]));
}

/** Runs one isolated Python migration agent and maps its wire result to a stage envelope. */
export async function runMigrationAgent<T=Record<string,unknown>>(
  stage:AgentStage,
  request:Record<string,unknown>,
  options:MigrationAgentOptions,
):Promise<AgentResult<T>>{
  const program=interpreter(options.projectRoot);
  const entry=path.join(options.projectRoot,ENTRY[stage]);
  const runtimeConfig=process.env.FINANCE_RUNTIME_CONFIG?.trim()??path.join(options.projectRoot,'.runtime.local.json');
  const assetDigest=String(request.assetDigest??'');
  const failed=(error:string,elapsedMs=0):AgentResult<T>=>stageEnvelope({
    assetDigest,stageId:stage,producer:'AGENT',status:'FAILED',
    payload:{judgement:{} as T},run:{elapsedMs,error},
  });
  if(!existsSync(program)||!existsSync(runtimeConfig))return failed('migration agent runtime is not available');

  const requestedDecisions=stage==='A4'&&Array.isArray((request as {decisions?:unknown[]}).decisions)
    ?(request as {decisions:unknown[]}).decisions.length:0;
  const iterationBudget=options.maxIterations??(stage==='A4'
    ?Math.min(agentIterations(stage),Math.max(28,20+requestedDecisions*8))
    :agentIterations(stage));
  const body=JSON.stringify({
    stage,
    model:{modelId:options.modelId,providerId:options.providerId??'service-execution'},
    maxIterations:iterationBudget,
    maxTokens:options.maxTokens??agentMaxTokens(stage),
    modelTimeoutMs:options.modelTimeoutMs??modelTimeoutMs(STAGE_ROLE[stage]),
    ...request,
  });

  return await new Promise<AgentResult<T>>((resolve,reject)=>{
    const child=spawn(program,[entry],{
      cwd:options.projectRoot,
      stdio:['pipe','pipe','pipe'],
      windowsHide:true,
      env:{...process.env,FINANCE_RUNTIME_CONFIG:runtimeConfig,PYTHONUTF8:'1',PYTHONUNBUFFERED:'1'},
    });
    let stdout='',stderr='',settled=false;
    const timer=setTimeout(()=>{
      if(settled)return;
      settled=true;
      child.kill('SIGKILL');
      reject(new MigrationAgentUnavailable(`${stage} agent exceeded ${options.timeoutMs??900_000}ms`));
    },options.timeoutMs??900_000);
    const abort=()=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new MigrationAgentUnavailable(`${stage} agent cancelled`));
    };
    options.signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',chunk=>{stdout+=String(chunk)});
    child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-4000)});
    child.on('error',error=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort',abort);
      reject(new MigrationAgentUnavailable(`${stage} agent could not start: ${error.message}`));
    });
    child.on('close',()=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort',abort);
      const line=stdout.split('\n').map(part=>part.trim()).filter(Boolean).reverse()
        .find(part=>part.startsWith('{')&&part.includes('"result"'));
      if(!line){resolve(failed(`agent produced no result line${stderr?`: ${stderr.slice(-500)}`:''}`));return}
      try{
        const wire=(JSON.parse(line) as {result?:WireResult<T>}).result??{};
        const status=String(wire.status??'').toUpperCase();
        const reason=failureReason(wire,status==='PRODUCED'||status==='ABSTAINED');
        resolve(stageEnvelope({
          assetDigest:String(wire.assetDigest??assetDigest),
          stageId:stage,
          producer:'AGENT',
          status:status==='PRODUCED'||status==='ABSTAINED'?status:'FAILED',
          payload:{
            judgement:(wire.payload??{}) as T,
            ...(wire.libraryInventory?{libraryInventory:wire.libraryInventory}:{}),
            ...(typeof wire.workspaceRoot==='string'?{workspaceRoot:wire.workspaceRoot}:{}),
            ...(wire.files?{files:wire.files}:{}),
            ...(wire.scanner?{scanner:wire.scanner}:{}),
          },
          ...(wire.trace?{trace:wire.trace}:{}),
          run:{
            ...(wire.modelId?{modelId:String(wire.modelId)}:{}),
            ...(typeof wire.elapsedMs==='number'?{elapsedMs:wire.elapsedMs}:{}),
            ...(reason?{error:reason}:{}),
          },
        }));
      }catch(error){
        resolve(failed(`agent result was not JSON: ${error instanceof Error?error.message:String(error)}`));
      }
    });
    child.stdin.end(body);
  });
}
