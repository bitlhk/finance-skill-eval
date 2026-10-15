import {useEffect,useState,useRef} from 'react';
import {CheckCircle2,LoaderCircle,PauseCircle,Sparkles} from 'lucide-react';

type Task={taskId:string;status:string;stage:string;reason:string|null;maxIterations:number;finalVerified:boolean;runtimeRequirements?:unknown;
  bestCandidate:{version:string};contextChanges?:Array<{environmentId:string;modelId:string}>;iterations:Array<{iteration:number;layer:string;outcome:string;passed?:number;total?:number;jobId?:string;summary?:string;changedPaths?:string[]}>;
  events:Array<{sequence:number;at:string;message:string}>};
type Evidence={cases:Array<{caseId:string;right:{status:string;toolCalls:Array<{name:string;status:string}>};judge?:{summary:string;goalAssessment?:{verdict:string}}}>};
type Api=<T>(url:string,init?:RequestInit)=>Promise<T>;
const statuses:Record<string,string>={RUNNING:'改进中',WAITING_BUILDER:'等待 Builder 交付',WAITING_CONFIGURATION:'等待运行配置',
  REVIEW:'等待选择候选',EXHAUSTED:'已达到停止条件',FAILED:'未达到目标',CANCELLED:'已停止',INTERRUPTED:'服务中断',ADOPTED:'已采用'};
const stages:Record<string,string>={PLANNING:'定位问题',IMPLEMENTING:'生成候选',TECHNICAL:'验证工具',EVALUATING:'开发集复测',FINAL_VERIFYING:'留出集复核',STOPPED:'已停止'};
const layers:Record<string,string>={SKILL:'Skill',TOOL:'Tool',HARNESS:'Harness',CONFIGURATION:'运行配置',EVALUATION:'测试方案',UNKNOWN:'待确认'};
const outcomes:Record<string,string>={PENDING:'进行中',PROMOTED:'有提升，保留',RETAINED:'无提升或回退',TECHNICAL_FAILED:'技术验证未通过'};

export function MigrationImprovementWorkbench(p:{api:Api;projectId:string;sourceJobId?:string;refresh:()=>Promise<void>;
  environmentId?:string;model?:{providerId:string;modelId:string;parameters?:Record<string,unknown>}}){
  const [tasks,setTasks]=useState<Task[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [iterations,setIterations]=useState(3),[minutes,setMinutes]=useState(30);
  const [evidence,setEvidence]=useState<Record<string,Evidence>>({});
  async function load(){setTasks(await p.api<Task[]>(`/api/migrations/${p.projectId}/improvement-tasks`));}
  useEffect(()=>{let alive=true;void p.api<Task[]>(`/api/migrations/${p.projectId}/improvement-tasks`).then(items=>{if(alive)setTasks(items)}).catch(e=>{if(alive)setError(String(e))});return()=>{alive=false};},[p.projectId,p.api]);
  const latest=tasks.at(-1),running=latest?.status==='RUNNING',waiting=latest?.status.startsWith('WAITING_');
  const lastStatus=useRef<string|undefined>(undefined);
  useEffect(()=>{if(lastStatus.current==='RUNNING'&&latest?.status!=='RUNNING')void p.refresh();lastStatus.current=latest?.status;},[latest?.status]);
  useEffect(()=>{
    if(!running)return;
    const timer=window.setInterval(()=>void load().catch(e=>setError(String(e))),2000);
    return()=>window.clearInterval(timer);
  },[running,p.projectId]);
  async function act(path:string,body?:unknown){
    setBusy(true);setError('');
    try{await p.api(`/api/migrations/${p.projectId}/improvement-tasks${path}`,{method:'POST',...(body?{body:JSON.stringify(body)}:{})});await load();await p.refresh();}
    catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  return <section className="stage-section improvement-workbench" aria-label="持续改进任务">
    <div className="stage-section-heading"><div><h4><Sparkles size={18}/> 按验收目标持续改进</h4><p>沿用这次评测的测试集、模型和运行配置。新候选独立验证，通过最终复核后再由你选择是否采用。</p></div>
      {latest&&<span className={`stage-badge ${latest.finalVerified?'success':running?'pending':'attention'}`}>{statuses[latest.status]??latest.status}</span>}
    </div>
    {!running&&!waiting&&<div className="migration-fields">
      <label>最多改进轮次<select value={iterations} disabled={busy} onChange={e=>setIterations(Number(e.target.value))}>{[1,2,3,4,5].map(n=><option key={n} value={n}>{n} 轮</option>)}</select></label>
      <label>最长运行时间<select value={minutes} disabled={busy} onChange={e=>setMinutes(Number(e.target.value))}>{[15,30,60,120].map(n=><option key={n} value={n}>{n} 分钟</option>)}</select></label>
      <button className="button primary" disabled={busy||!p.sourceJobId||latest?.status==='REVIEW'} onClick={()=>void act('',{jobId:p.sourceJobId,maxIterations:iterations,maxDurationSeconds:minutes*60})}>开始持续改进</button>
    </div>}
    {!latest&&<p className="stage-inline-note">需要一次目标评估，以及独立的冻结留出题。原候选在任务期间保持不变。</p>}
    {latest&&<div className="assessment-result">
      <div className="improvement-progress">{running?<LoaderCircle size={18}/>:latest.finalVerified?<CheckCircle2 size={18}/>:<PauseCircle size={18}/>}<strong>{running?stages[latest.stage]:statuses[latest.status]}</strong><span>已开始 {latest.iterations.length}/{latest.maxIterations} 轮</span></div>
      {latest.reason&&<p>{latest.reason}</p>}
      <p>当前最佳候选：{latest.bestCandidate.version}</p>
      {!!latest.contextChanges?.length&&<p>本任务包含 Runtime 或配置变化，结果属于整套方案改进，不能单独归因于 Skill。</p>}
      {latest.iterations.map(item=><details className="stage-detail" key={item.iteration}><summary>第 {item.iteration} 轮 · {layers[item.layer]??item.layer} · {outcomes[item.outcome]}{item.total!==undefined?` · 开发集 ${item.passed}/${item.total} 通过`:''}</summary>
        {item.summary&&<p>{item.summary}</p>}{!!item.changedPaths?.length&&<p>改动文件：{item.changedPaths.join('、')}</p>}
        {item.jobId&&!evidence[item.jobId]&&<button className="button secondary" onClick={()=>void p.api<{report:Evidence}>(`/api/runs/${item.jobId}`).then(job=>setEvidence(old=>({...old,[item.jobId!]:job.report}))).catch(e=>setError(String(e)))}>查看本轮评测证据</button>}
        {item.jobId&&evidence[item.jobId]?.cases.map(c=><article key={c.caseId}><strong>{c.caseId} · {c.judge?.goalAssessment?.verdict==='PASS'?'通过':c.judge?.goalAssessment?.verdict==='FAIL'?'不通过':'无法判定'}</strong><p>{c.judge?.summary}</p><p>工具：{c.right.toolCalls.map(call=>`${call.name}（${call.status==='completed'?'已完成':'未完成'}）`).join('、')||'无调用记录'}</p></article>)}
      </details>)}
      {!!latest.events.length&&<details className="stage-detail"><summary>查看执行记录（{latest.events.length}）</summary>{[...latest.events].reverse().map(event=><p key={event.sequence}>{new Date(event.at).toLocaleTimeString('zh-CN',{hour12:false})} · {event.message}</p>)}</details>}
      {latest.status==='REVIEW'&&latest.finalVerified&&<button className="button primary" disabled={busy} onClick={()=>void act(`/${latest.taskId}/adopt`)}>采用已通过复核的候选</button>}
      {waiting&&(latest.status==='WAITING_BUILDER'&&!latest.runtimeRequirements
        ?<><p>当前假设缺少可执行的 Builder 能力合同。补全需求会重新分析同一开发集，不改测试标准或读取留出题。</p><button className="button primary" disabled={busy} onClick={()=>void act(`/${latest.taskId}/replan-builder`)}>补全 Builder 需求</button></>
        :<><p>完成 Runtime 适配或运行配置后，在下方选择要验证的 Runtime 和模型，再继续。测试集与验收要求保持不变。</p><button className="button primary" disabled={busy||!p.environmentId||!p.model} onClick={()=>void act(`/${latest.taskId}/resume`,{environmentId:p.environmentId,model:p.model?{providerId:p.model.providerId,modelId:p.model.modelId,parameters:p.model.parameters??{}}:undefined})}>使用所选 Runtime 继续</button></>)}
      {(running||waiting)&&<button className="button secondary" disabled={busy} onClick={()=>void act(`/${latest.taskId}/cancel`)}>停止此任务</button>}
    </div>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
