import {useEffect,useRef,useState} from 'react';
import {ArrowDown,Check,LoaderCircle,AlertCircle,Square} from 'lucide-react';
import {apiPath,authHeaders} from './api-path';
import type {Activity} from '../../src/migration/infrastructure/migration-activity';
import './migration-activity.css';

export function MigrationActivity({projectId}:{projectId:string}){
  const [activity,setActivity]=useState<Activity|null>(null),[connected,setConnected]=useState(false),[clock,setClock]=useState(Date.now()),[following,setFollowing]=useState(true),[unseen,setUnseen]=useState(false),[error,setError]=useState('');
  const viewport=useRef<HTMLDivElement>(null),follow=useRef(true),version=useRef('');
  useEffect(()=>{let stopped=false;const controller=new AbortController();setActivity(null);setConnected(false);version.current='';follow.current=true;setFollowing(true);setUnseen(false);
    const run=async()=>{while(!stopped){const attempt=new AbortController();let watchdog=setTimeout(()=>attempt.abort(),20000);try{
      const response=await fetch(apiPath(`/api/migrations/${projectId}/activity/events`),{headers:authHeaders(),signal:AbortSignal.any([controller.signal,attempt.signal])});
      if(!response.ok||!response.body)throw new Error('连接失败');
      const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';setConnected(true);
      while(!stopped){const chunk=await reader.read();if(chunk.done)break;clearTimeout(watchdog);watchdog=setTimeout(()=>attempt.abort(),20000);pending+=decoder.decode(chunk.value,{stream:true});let end:number;
        while((end=pending.indexOf('\n\n'))>=0){const packet=pending.slice(0,end);pending=pending.slice(end+2);const line=packet.split('\n').find(value=>value.startsWith('data: '));if(!line)continue;
          const next=JSON.parse(line.slice(6)) as Activity|null;const key=next?`${next.taskId}:${next.updatedAt}:${next.status}`:'';
          if(key!==version.current){version.current=key;setActivity(next);if(!follow.current)setUnseen(true);}
        }
      }
    }catch{/* A network disconnect does not change the task status. */}finally{clearTimeout(watchdog);}
    if(!stopped){setConnected(false);await new Promise(resolve=>setTimeout(resolve,1500));}}
    };void run();const tick=setInterval(()=>setClock(Date.now()),1000);
    return ()=>{stopped=true;controller.abort();clearInterval(tick);};
  },[projectId]);
  useEffect(()=>{if(follow.current&&viewport.current)viewport.current.scrollTop=viewport.current.scrollHeight;},[activity]);
  if(!activity)return null;
  const running=activity.status==='RUNNING',last=activity.events.at(-1);
  const labels={RUNNING:'正在运行',COMPLETED:'执行结束',FAILED:'执行失败',CANCELLED:'已取消',INTERRUPTED:'执行已中断'};
  const duration=Math.max(0,Math.floor(((running?clock:Date.parse(activity.updatedAt))-Date.parse(activity.startedAt))/1000));
  const cancel=async()=>{setError('');try{const result=await fetch(apiPath(`/api/migrations/${projectId}/activity/cancel`),{method:'POST',headers:authHeaders()});if(!result.ok)throw new Error();}catch{setError('取消请求未成功，请重试');}};
  return <section className="agent-activity" aria-label="Agent 实时活动">
    <header className="activity-heading"><div><span className={`activity-dot ${running?'active':''}`}/><strong>{labels[activity.status]}</strong><span className="activity-duration">{Math.floor(duration/60)}分{duration%60}秒</span></div><p aria-live="polite">{running?last?.label:labels[activity.status]}</p></header>
    <div className="activity-scroll" ref={viewport} tabIndex={0} aria-label="活动记录" onScroll={()=>{const el=viewport.current;if(!el)return;const near=el.scrollHeight-el.scrollTop-el.clientHeight<36;follow.current=near;setFollowing(near);if(near)setUnseen(false);}}>
      <ol>{activity.events.map((event,index)=>{const failed=event.kind.includes('error')||event.kind==='failed';const active=running&&index===activity.events.length-1;return <li key={`${activity.taskId}:${event.id}`} className={failed?'activity-error':''}>
        <span className="activity-icon">{failed?<AlertCircle size={15}/>:active?<LoaderCircle size={15} className="activity-spinner"/>:<Check size={15}/>}</span>
        <div><div className="activity-row"><strong>{event.label}</strong><time>{new Date(event.at).toLocaleTimeString('zh-CN',{hour12:false})}</time></div>
        {event.text&&<details><summary>查看响应内容</summary><pre>{event.text}</pre></details>}</div>
      </li>;})}</ol>
    </div>
    {!following&&<button className="button secondary compact activity-latest" onClick={()=>{follow.current=true;setFollowing(true);setUnseen(false);if(viewport.current)viewport.current.scrollTop=viewport.current.scrollHeight;}}><ArrowDown size={14}/>{unseen?'有新活动 · 回到最新':'回到最新'}</button>}
    <footer><span>{connected?`最近活动：${Math.max(0,Math.floor((clock-Date.parse(activity.updatedAt))/1000))} 秒前`:'连接中断，正在重新连接…'}</span>{running&&<button className="button secondary compact" onClick={()=>void cancel()}><Square size={12}/>取消任务</button>}</footer>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
