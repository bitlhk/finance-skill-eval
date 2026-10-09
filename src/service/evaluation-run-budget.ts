/** One bounded execution budget shared by the in-process account workspaces. */
export class EvaluationRunBudget {
  private active=0;
  private readonly queue:Array<()=>void>=[];
  constructor(private readonly limit:number){
    if(!Number.isInteger(limit)||limit<1||limit>4)throw new Error('EVALUATION_RUN_LIMIT_INVALID');
  }
  schedule(task:()=>Promise<void>,signal:AbortSignal):Promise<void>{
    if(signal.aborted)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const cancel=()=>{
        const index=this.queue.indexOf(start);
        if(index>=0){this.queue.splice(index,1);resolve();}
      };
      const start=()=>{
        signal.removeEventListener('abort',cancel);
        if(signal.aborted){resolve();return;}
        this.active++;
        Promise.resolve().then(task).then(resolve,reject).finally(()=>{this.active--;this.pump();});
      };
      signal.addEventListener('abort',cancel,{once:true});
      this.queue.push(start);this.pump();
    });
  }
  private pump(){while(this.active<this.limit&&this.queue.length)this.queue.shift()!();}
}
