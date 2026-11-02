/** Bound an entire role invocation, including format repair, even if an adapter ignores cancellation. */
export async function boundedAgentCall<T>(options:{signal?:AbortSignal;timeoutMs?:number},
  call:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  options.signal?.throwIfAborted();
  const timeoutMs=options.timeoutMs??120_000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new Error('Invalid role timeout');
  const timeout=new AbortController();
  const signal=options.signal?AbortSignal.any([options.signal,timeout.signal]):timeout.signal;
  const timer=setTimeout(()=>timeout.abort(new DOMException('Agent role timed out','TimeoutError')),timeoutMs);
  let abort:()=>void=()=>{};
  try{
    const cancelled=new Promise<never>((_,reject)=>{
      abort=()=>reject(signal.reason);
      signal.addEventListener('abort',abort,{once:true});
    });
    const result=await Promise.race([call(signal),cancelled]);
    signal.throwIfAborted();
    return result;
  }finally{
    clearTimeout(timer);
    signal.removeEventListener('abort',abort);
  }
}
