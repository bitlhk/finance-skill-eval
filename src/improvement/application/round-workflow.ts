/** One scheduler for all optimization entry points. Business adapters own data and policy,
 * never their own diagnosis -> adjustment -> evaluation -> review loop. */
export type RoundStep<T>={status:'READY';value:T}|{status:'STOP'}|{status:'NEXT_ROUND'};
export type RoundWorkflow<D,C,E,R>={
  firstRound:number;maxRounds:number;signal:AbortSignal;
  prepare(number:number,resuming:boolean):Promise<boolean>;
  diagnose(number:number):Promise<RoundStep<D>>;
  adjust(diagnosis:D,number:number):Promise<RoundStep<C>>;
  evaluate(candidate:C,number:number):Promise<E>;
  review(candidate:C,evaluation:E,number:number):Promise<R>;
  select(candidate:C,evaluation:E,review:R,number:number):Promise<boolean|void>;
  resume?:()=>Promise<C>;
  exhausted():Promise<void>;
};

export async function runRoundWorkflow<D,C,E,R>(ports:RoundWorkflow<D,C,E,R>){
  for(let number=ports.firstRound;number<=ports.maxRounds;number++){
    const resuming=number===ports.firstRound&&!!ports.resume;
    ports.signal.throwIfAborted();
    if(!await ports.prepare(number,resuming))return;
    ports.signal.throwIfAborted();
    let candidate:C;
    if(resuming)candidate=await ports.resume!();
    else{
      const diagnosis=await ports.diagnose(number);
      ports.signal.throwIfAborted();
      if(diagnosis.status==='STOP')return;
      if(diagnosis.status==='NEXT_ROUND')continue;
      const adjustment=await ports.adjust(diagnosis.value,number);
      ports.signal.throwIfAborted();
      if(adjustment.status==='STOP')return;
      if(adjustment.status==='NEXT_ROUND')continue;
      candidate=adjustment.value;
    }
    ports.signal.throwIfAborted();
    const evaluation=await ports.evaluate(candidate,number);
    ports.signal.throwIfAborted();
    const review=await ports.review(candidate,evaluation,number);
    ports.signal.throwIfAborted();
    const stop=await ports.select(candidate,evaluation,review,number);
    ports.signal.throwIfAborted();
    if(stop)return;
  }
  await ports.exhausted();
}
