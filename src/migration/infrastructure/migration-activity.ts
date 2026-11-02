import {AsyncLocalStorage} from 'node:async_hooks';
import {EventEmitter} from 'node:events';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Activity} from '../domain/migration-activity.js';
import type {MigrationActivityPort} from '../application/migration-activity-port.js';
export type {Activity,ActivityEvent} from '../domain/migration-activity.js';

type Context={emit:(kind:string,label:string,text?:string)=>void;signal:AbortSignal};
export const migrationActivityContext=new AsyncLocalStorage<Context>();
export class MigrationActivityStore implements MigrationActivityPort{
  private tasks=new Map<string,{state:Activity;controller:AbortController}>();
  private bus=new EventEmitter();
  private writes=new Map<string,Promise<void>>();
  constructor(private root:string){this.bus.setMaxListeners(0);}
  emit(kind:string,label:string,text?:string){migrationActivityContext.getStore()?.emit(kind,label,text);}
  private file(id:string){return path.join(this.root,'migration-activity',encodeURIComponent(id)+'.json');}
  private save(id:string,state:Activity){
    const value=JSON.stringify(state),filename=this.file(id);
    const next=(this.writes.get(id)??Promise.resolve()).catch(()=>{}).then(async()=>{
      await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename+'.tmp',value);await rename(filename+'.tmp',filename);
    });
    this.writes.set(id,next);void next.catch(()=>{});
  }
  async get(id:string):Promise<Activity|null>{
    const active=this.tasks.get(id);if(active)return structuredClone(active.state);
    try{const state=JSON.parse(await readFile(this.file(id),'utf8')) as Activity;
      if(state.status==='RUNNING')state.status='INTERRUPTED';return state;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }
  subscribe(id:string,listener:()=>void){this.bus.on(id,listener);return ()=>{this.bus.off(id,listener);};}
  cancel(id:string){const task=this.tasks.get(id);if(task?.state.status==='RUNNING')task.controller.abort();}
  async run<T>(id:string,fn:()=>Promise<T>,options:{signal?:AbortSignal;taskId?:string;terminalStatus?:()=>Promise<Activity['status']>}={}):Promise<T>{
    if(this.tasks.get(id)?.state.status==='RUNNING')throw Object.assign(new Error('该工程已有任务正在执行'),{statusCode:409});
    const controller=new AbortController(),now=new Date().toISOString();
    const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
    const state:Activity={taskId:options.taskId??randomUUID(),status:'RUNNING',startedAt:now,updatedAt:now,events:[]};
    const task={state,controller};this.tasks.set(id,task);let sequence=0,lastSave=0;
    const emit=(kind:string,label:string,text?:string)=>{
      state.updatedAt=new Date().toISOString();
      const last=state.events.at(-1);
      if(kind==='text_snapshot'&&last?.kind==='text_snapshot')last.text=(text??'').slice(-12000);
      else state.events.push({id:++sequence,at:state.updatedAt,kind,label:label.slice(0,180),...(text?{text:text.slice(-12000)}:{})});
      if(state.events.length>200)state.events.splice(0,state.events.length-200);
      if(Date.now()-lastSave>1000||state.status!=='RUNNING'){this.save(id,state);lastSave=Date.now();}
      this.bus.emit(id);
    };
    emit('started','开始执行');
    try{return await migrationActivityContext.run({emit,signal},async()=>{
      const result=await fn();if(signal.aborted&&!options.terminalStatus)throw new Error('任务已取消');
      state.status=options.terminalStatus?await options.terminalStatus():'COMPLETED';
      const labels={RUNNING:'正在运行',COMPLETED:'执行结束',FAILED:'执行失败',CANCELLED:'任务已取消',INTERRUPTED:'执行已中断'};
      emit(state.status.toLowerCase(),labels[state.status]);return result;
    });}catch(error){state.status=signal.aborted?'CANCELLED':'FAILED';emit(state.status==='CANCELLED'?'cancelled':'failed',state.status==='CANCELLED'?'任务已取消':'执行失败，请查看页面错误提示');throw error;}
    finally{await this.writes.get(id)?.catch(()=>{});if(this.tasks.get(id)===task){this.tasks.delete(id);this.writes.delete(id);}}
  }
}
