import {useEffect, useRef, useState, type ReactNode} from 'react';
import type {BundleTask} from "../../../../contracts/platform/responses";
import type {MigrationApi} from './useMigrationTask';
import {MarkdownContent} from '../../MarkdownContent';
import {workProducts} from './work-products';
import {conversationCursor,mergeConversationEvents,type ConversationEvent} from './conversation-events';
import {caseProposal,type CaseProposal} from './case-proposals';
import {pendingBudgetContinuation} from './active-operation';

type Question = {header?:string;question:string;options?:Array<{label:string;description?:string}>;multi_select?:boolean};
type Interaction = {interactionId:string;request:unknown;status:string;answer?:unknown};

function questionsOf(request:unknown):Question[] {
  if(!request||typeof request!=='object')return [];
  const outer=request as Record<string,unknown>;
  const value=outer.value&&typeof outer.value==='object'?outer.value as Record<string,unknown>:outer;
  if(!Array.isArray(value.questions))return [];
  return value.questions.filter((item):item is Question=>Boolean(item&&typeof item==='object'&&typeof item.question==='string'));
}

export function TaskConversationQuestion({task,api,setTask,activity,onApplyProposal}:{task:BundleTask;api:MigrationApi;setTask:(task:BundleTask)=>void;activity?:ReactNode;onApplyProposal?:(proposal:CaseProposal)=>void}) {
  const attempt=[...task.attempts].reverse().find(item=>item.status==='WAITING'&&item.waitingInteractionIds?.length);
  const [interaction,setInteraction]=useState<Interaction|null>(null);
  const [events,setEvents]=useState<ConversationEvent[]>([]);
  const [answers,setAnswers]=useState<Record<string,string>>({});
  const [selections,setSelections]=useState<Record<string,string[]>>({});
  const [error,setError]=useState('');
  const [readError,setReadError]=useState('');
  const [busy,setBusy]=useState(false);
  const [instruction,setInstruction]=useState('');
  const [sending,setSending]=useState(false);
  const [additionalRounds,setAdditionalRounds]=useState(1);
  const [additionalSeconds,setAdditionalSeconds]=useState(0);
  const pendingInstruction=useRef<{taskId:string;text:string;key:string}|null>(null);
  const pendingAnswer=useRef<{taskId:string;interactionId:string;content:string;key:string}|null>(null);
  const handoffPending=Boolean(pendingBudgetContinuation(task));
  const running=task.attempts.some(item=>item.status==='RUNNING')||handoffPending;
  const activeSession=[...task.attempts].reverse().find(item=>item.status==='RUNNING'&&['PREPARE','ANALYZE','GENERATE','REPAIR','CHAT'].includes(item.kind)
    &&item.sessionExecutionId&&item.agentEvaluation!=='RUNNING'&&item.agentReview!=='RUNNING');
  const latestAttempt=task.attempts.at(-1);
  const interruptedPause=!activeSession&&latestAttempt?.status==='INTERRUPTED'&&latestAttempt.sessionControl?latestAttempt:undefined;
  const control=activeSession?.sessionControl?.status;
  useEffect(()=>{
    let cancelled=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let cached:ConversationEvent[]=[];
    const read=async()=>{
      let failed=false;
      try{
        let after=conversationCursor(cached);const updates:ConversationEvent[]=[];let interactions:Interaction[]=[];
        for(;;){
          const page=await api<{events:ConversationEvent[];interactions:Interaction[]}>(`/api/migration-tasks/${task.id}/conversation?after=${after}&limit=500`);
          updates.push(...page.events);interactions=page.interactions;
          if(page.events.length<500)break;
          after=page.events[page.events.length-1]!.sequence;
        }
        cached=mergeConversationEvents(cached,updates);
        if(!cancelled){setReadError('');setEvents(cached);setInteraction(interactions.find(item=>attempt?.waitingInteractionIds?.includes(item.interactionId)&&['pending','answered'].includes(item.status))??null);}
      }catch(reason){failed=true;if(!cancelled)setReadError(reason instanceof Error?reason.message:String(reason));}
      finally{if(!cancelled&&(running||failed))timer=setTimeout(()=>void read(),1500);}
    };
    void read();
    return ()=>{cancelled=true;if(timer)clearTimeout(timer);};
  },[api,task.id,attempt?.id,attempt?.status,running]);
  useEffect(()=>{
    setSelections({});
    if(interaction?.status==='answered'&&interaction.answer&&typeof interaction.answer==='object'&&!Array.isArray(interaction.answer)){
      const saved=Object.fromEntries(Object.entries(interaction.answer).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
      setAnswers(saved);
    }else setAnswers({});
  },[task.id,interaction?.interactionId,interaction?.status]);
  const questions=questionsOf(interaction?.request);
  const planEvent=[...events].reverse().find(event=>event.kind==='plan');
  const planPayload=planEvent?.payload&&typeof planEvent.payload==='object'?planEvent.payload as {items?:unknown}:null;
  const plan=Array.isArray(planPayload?.items)?planPayload.items.filter((item):item is {id:string;content:string;status:string}=>
    Boolean(item&&typeof item==='object'&&typeof item.id==='string'&&typeof item.content==='string'&&typeof item.status==='string')):[];
  const products=workProducts(events);
  const deliveryReview=[...(task.deliveryReviews??[])].reverse().find(item=>item.candidateId===task.currentCandidateId
    &&item.scopeCurrent===true);
  const currentDigest=task.candidates.find(item=>item.id===task.currentCandidateId)?.digest;
  const effectReview=[...(task.effectReviews??[])].reverse().find(item=>item.candidateDigest===currentDigest);
  const optimizationOwner=[...task.attempts].reverse().find(item=>item.kind==='CHAT'&&item.optimization);
  const optimization=optimizationOwner?.optimization;
  const lastBudgetRequest=latestAttempt?.budgetContinuation && latestAttempt.budgetContinuation.ownerAttemptId===optimizationOwner?.id
    ?latestAttempt.budgetContinuation:undefined;
  const pendingResume=useRef<{taskId:string;ownerId:string;additionalRounds?:number;additionalSeconds?:number;key:string}|null>(null);
  async function submit(){
    if(!interaction||!attempt||busy)return;
    const content=JSON.stringify(answers);
    if(!pendingAnswer.current||pendingAnswer.current.taskId!==task.id||pendingAnswer.current.interactionId!==interaction.interactionId||pendingAnswer.current.content!==content)
      pendingAnswer.current={taskId:task.id,interactionId:interaction.interactionId,content,key:crypto.randomUUID()};
    setBusy(true);setError('');
    try{
      const next=await api<BundleTask>(`/api/migration-tasks/${task.id}/conversation/answer`,{method:'POST',body:JSON.stringify({
        key:pendingAnswer.current.key,attemptId:attempt.id,interactionId:interaction.interactionId,answers,
      })});
      pendingAnswer.current=null;
      setTask(next);
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
    finally{setBusy(false);}
  }
  async function sendInstruction(){
    const text=instruction.trim();
    if(!text||sending)return;
    if(!pendingInstruction.current||pendingInstruction.current.taskId!==task.id||pendingInstruction.current.text!==text)
      pendingInstruction.current={taskId:task.id,text,key:crypto.randomUUID()};
    setSending(true);setError('');
    try{
      const response=await api<{status:string;task?:BundleTask}>(`/api/migration-tasks/${task.id}/conversation/message`,{method:'POST',body:JSON.stringify({key:pendingInstruction.current.key,text})});
      if(response.task)setTask(response.task);
      pendingInstruction.current=null;
      setInstruction(current=>current.trim()===text?'':current);
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
    finally{setSending(false);}
  }
  async function controlSession(action:'pause'|'resume'){
    if(busy)return;
    setBusy(true);setError('');
    try{setTask(await api<BundleTask>(`/api/migration-tasks/${task.id}/conversation/control/${action}`,{method:'POST'}));}
    catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
    finally{setBusy(false);}
  }
  async function checkControl(){
    if(busy)return;
    setBusy(true);setError('');
    try{setTask(await api<BundleTask>(`/api/migration-tasks/${task.id}/conversation/control`));}
    catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
    finally{setBusy(false);}
  }
  async function cancelPaused(){
    if(busy)return;
    setBusy(true);setError('');
    try{setTask(await api<BundleTask>(`/api/migration-tasks/${task.id}/cancel`,{method:'POST'}));}
    catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
    finally{setBusy(false);}
  }
  async function resumeOptimization(extraRounds?:number,extraSeconds?:number){
    if(!optimizationOwner||busy)return;
    if(extraRounds!==undefined&&(!Number.isInteger(extraRounds)||extraRounds<1||extraRounds>1000)){setError('请输入 1 到 1000 之间的整数轮次');return;}
    if(extraSeconds!==undefined&&(!Number.isInteger(extraSeconds)||extraSeconds<60||extraSeconds>7200)){setError('增加的时间请输入 60 到 7200 秒之间的整数');return;}
    if(!pendingResume.current||pendingResume.current.taskId!==task.id||pendingResume.current.ownerId!==optimizationOwner.id||pendingResume.current.additionalRounds!==extraRounds||pendingResume.current.additionalSeconds!==extraSeconds)
      pendingResume.current={taskId:task.id,ownerId:optimizationOwner.id,additionalRounds:extraRounds,additionalSeconds:extraSeconds,key:crypto.randomUUID()};
    setBusy(true);setError('');
    try{
      const next=await api<BundleTask>(`/api/migration-tasks/${task.id}/conversation/optimization/resume`,{method:'POST',body:JSON.stringify({
        key:pendingResume.current.key,ownerAttemptId:optimizationOwner.id,...(extraRounds?{additionalRounds:extraRounds}:{}),...(extraSeconds?{additionalSeconds:extraSeconds}:{})})});
      pendingResume.current=null;setTask(next);
    }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
    finally{setBusy(false);}
  }
  return <section className="task-workbench" aria-label="迁移工作区">
    <section className="task-current-plan" aria-label="当前计划"><h3>当前计划</h3>{plan.length>0?<ol>{plan.map(item=><li key={item.id}>
      {({pending:'待处理',in_progress:'进行中',completed:'已完成',cancelled:'已取消'} as Record<string,string>)[item.status]??item.status} · {item.content}
    </li>)}</ol>:<p>Agent 建立计划后将在这里展示进展。</p>}</section>
    {optimization&&<section className="task-current-plan" aria-label="优化进展"><h3>优化进展</h3>
      <p>{optimization.goal.goal} · 目标通过率 {Math.round(optimization.goal.targetPassRate*100)}% · 已完成审查 {optimization.rounds.filter(round=>round.stage==='SELECTION').length} / {optimization.goal.maxRounds} 轮</p>
      <p>{optimization.reason??({RUNNING:'正在优化',WAITING:'等待处理',REVIEW:'优化已暂停，结果待查看',STOPPED:'已停止',FAILED:'优化未完成',CANCELLED:'已取消',INTERRUPTED:'优化已中断，工作与证据已保留'} as Record<string,string>)[optimization.status]}</p>
      {!running&&['REVIEW','STOPPED'].includes(optimization.status)&&optimization.best.id!==task.currentCandidateId&&<button type="button" className="button secondary" disabled={busy} onClick={()=>void (async()=>{
        setBusy(true);setError('');
        try{setTask(await api<BundleTask>(`/api/migration-tasks/${task.id}/optimization-selection`,{method:'POST',body:JSON.stringify({attemptId:optimizationOwner!.id})}));}
        catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false);}
      })()}>使用推荐版本</button>}
      {lastBudgetRequest?.status==='PENDING'&&<p role="status">正在核对对话中提出的预算和续跑条件。</p>}
      {lastBudgetRequest?.status==='FAILED'&&<p role="alert">优化未能继续：{lastBudgetRequest.error??'请核对任务状态后重试。'}</p>}
      {optimization.status==='INTERRUPTED'&&!attempt&&<button type="button" className="button secondary" disabled={busy||running}
        onClick={()=>void resumeOptimization()}>继续当前优化</button>}
      {optimization.status==='INTERRUPTED'&&!attempt&&optimization.goal.maxDurationSeconds!==undefined&&<div>
        <label>增加时间（秒）<input type="number" min={60} max={7200} step={1} value={additionalSeconds} disabled={busy||running}
          onChange={event=>setAdditionalSeconds(Number(event.target.value))}/></label>
        <button type="button" className="button secondary" disabled={busy||running} onClick={()=>void resumeOptimization(undefined,additionalSeconds)}>增加时间并继续本轮</button>
      </div>}
      {optimization.status==='REVIEW'&&!optimization.targetReached&&optimization.stage!=='ADJUSTMENT'&&optimization.rounds.at(-1)?.stage==='SELECTION'
        &&optimization.working?.id===task.currentCandidateId&&!attempt&&<div>
          <label>增加优化轮次<input type="number" min={1} max={1000} step={1} value={additionalRounds} disabled={busy||running}
            onChange={event=>setAdditionalRounds(Number(event.target.value))}/></label>
          {optimization.goal.maxDurationSeconds!==undefined&&<label>增加时间（秒，0 表示不增加）<input type="number" min={0} max={7200} step={1} value={additionalSeconds} disabled={busy||running}
            onChange={event=>setAdditionalSeconds(Number(event.target.value))}/></label>}
          <button type="button" className="button secondary" disabled={busy||running} onClick={()=>void resumeOptimization(additionalRounds,additionalSeconds||undefined)}>增加预算并继续</button>
          <p>保留已完成的轮次与评测记录；如时间预算已用完，请同时增加时间。总时间预算最多 7200 秒。</p>
        </div>}
      {optimization.status==='REVIEW'&&!optimization.targetReached&&optimization.stage==='ADJUSTMENT'
        &&optimization.goal.maxDurationSeconds!==undefined&&!attempt&&<div>
          <label>增加时间（秒）<input type="number" min={60} max={7200} step={1} value={additionalSeconds} disabled={busy||running}
            onChange={event=>setAdditionalSeconds(Number(event.target.value))}/></label>
          <button type="button" className="button secondary" disabled={busy||running} onClick={()=>void resumeOptimization(undefined,additionalSeconds)}>增加时间并继续当前调整</button>
          <p>保留已调整的文件，继续执行评测；总时间预算最多 7200 秒。</p>
        </div>}
    </section>}
    <div className="task-workbench-columns"><section className="task-dialogue" aria-label="任务对话">
    <h3>任务对话</h3>
    <div className="task-dialogue-events" aria-live="polite">
    {events.map(event=>{
      const payload=event.payload&&typeof event.payload==='object'?event.payload as Record<string,unknown>:{};
      if(event.kind==='question')return <div key={event.sequence}><strong>Agent 提问</strong>
        {questionsOf(payload).map(question=><p key={question.question}>{question.question}</p>)}</div>;
      if(event.kind==='answer')return <div key={event.sequence}><strong>你的回答</strong>
        {Object.entries(payload).map(([question,answer])=><p key={question}>{question}：{String(answer)}</p>)}</div>;
      if(event.kind==='message')return <div key={event.sequence}><strong>{payload.role==='user'?'你':'Agent'}</strong>
        {typeof payload.text==='string'&&(payload.role==='user'?<p style={{whiteSpace:'pre-wrap'}}>{payload.text}</p>:<MarkdownContent content={payload.text} formatJson={false}/>)}
        {event.deliveryStatus&&<small>{({queued:'等待发送',sending:'发送中或状态待确认',accepted:'已接收，等待处理',uncertain:'接收状态待确认'} as const)[event.deliveryStatus]}</small>}
      </div>;
      if(event.kind==='work_product'&&typeof payload.title==='string')return <p key={event.sequence}>更新工作产物：{payload.title}</p>;
      if(event.kind==='case_proposal'){
        const proposal=caseProposal(payload);
        if(!proposal)return <p key={event.sequence}>测试案例建议暂时无法显示，请让 Agent 重新整理。</p>;
        return <article key={event.sequence} className="task-product" aria-label="开发测试案例建议">
          <h4>{proposal.name}</h4><p>{proposal.coverage}</p>
          {proposal.cases.map((item,index)=><section key={index}><strong>案例 {index+1}</strong><p>{item.input}</p>
            <ul>{item.criteria.map((criterion,i)=><li key={i}>{criterion}</li>)}</ul>{item.rationale&&<p>{item.rationale}</p>}</section>)}
          <p>这是待审阅的开发案例，不会自动保存或运行；业务数据、判断标准和只读条件需核对。</p>
          {onApplyProposal&&<button type="button" className="button secondary" disabled={running||busy} onClick={()=>{
            try{onApplyProposal(proposal);setError('');}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
          }}>加入测试集草稿</button>}
        </article>;
      }
      if(event.kind==='task_goal'&&typeof payload.goal==='string')return <div key={event.sequence}><strong>Agent 记录的任务目标</strong>
        <p>{payload.goal}</p>{typeof payload.target==='string'&&<p>交付目标：{payload.target}</p>}</div>;
      if(event.kind==='warning'&&typeof payload.label==='string')return <div key={event.sequence} role="status">
        <strong>{payload.label}</strong>{typeof payload.text==='string'&&<p>{payload.text}</p>}</div>;
      if(event.kind.startsWith('tool_')&&typeof payload.label==='string')return <div key={event.sequence}>
        <p>{payload.label}</p>{event.kind==='tool_error'&&typeof payload.text==='string'&&payload.text&&<pre>{payload.text}</pre>}
      </div>;
      return null;
    })}
    {activity}
    </div>
    {attempt&&<div className="task-question" aria-label="等待回答"><h4>需要你的回答</h4>
    {!interaction&&!readError&&<p>正在读取问题…</p>}
    {interaction&&!questions.length&&<p>问题内容暂时无法显示，请稍后重试。</p>}
    {interaction?.status==='answered'&&<p>你的回答已保存，会话启动后将继续提交这份回答。</p>}
    {questions.map(question=><div key={question.question} className="stage-section">
      <p><strong>{question.question}</strong></p>
      {question.options?.map(option=><button key={option.label} type="button" className="button secondary"
        disabled={interaction?.status==='answered'}
        aria-pressed={(selections[question.question]??[]).includes(option.label)} title={option.description}
        onClick={()=>{
          const previous=selections[question.question]??[];
          const selected=question.multi_select
            ?previous.includes(option.label)?previous.filter(label=>label!==option.label):[...previous,option.label]
            :[option.label];
          setSelections(current=>({...current,[question.question]:selected}));
          setAnswers(current=>({...current,[question.question]:selected.join('、')}));
        }}>{option.label}</button>)}
      <label>你的回答<textarea value={answers[question.question]??''} readOnly={interaction?.status==='answered'}
        onChange={event=>setAnswers(current=>({...current,[question.question]:event.target.value}))}/></label>
    </div>)}
    <button className="button primary" disabled={busy||!questions.length||questions.some(q=>!answers[q.question]?.trim())}
      onClick={()=>void submit()}>提交回答并继续</button>
    </div>}
    {!attempt&&<div aria-label="任务消息">
      {interruptedPause&&<div>
        {interruptedPause.sessionControl?.status==='RECOVERABLE'
          ?<><p role="status">已找到暂停检查点，可继续原任务。</p><button type="button" className="button secondary" disabled={busy} onClick={()=>void controlSession('resume')}>恢复暂停任务</button><button type="button" className="button secondary" disabled={busy} onClick={()=>void cancelPaused()}>取消原执行</button></>
          :<><p role="status">原执行已中断，请先核对暂停检查点和 Runtime 状态。</p><button type="button" className="button secondary" disabled={busy} onClick={()=>void checkControl()}>核对状态</button></>}
      </div>}
      {activeSession&&<div>
        {control==='UNKNOWN'&&<div><p role="status">暂停状态尚未确认，请核对当前执行状态。</p><button type="button" className="button secondary" disabled={busy} onClick={()=>void checkControl()}>核对状态</button></div>}
        {control==='PAUSED'&&<p role="status">任务已暂停。补充要求会先保存，在继续时发送。</p>}
        {!control&&<button type="button" className="button secondary" disabled={busy} onClick={()=>void controlSession('pause')}>暂停</button>}
        {control==='PAUSED'&&<button type="button" className="button secondary" disabled={busy} onClick={()=>void controlSession('resume')}>继续</button>}
        {(control==='PAUSING'||control==='RESUMING')&&<div><p role="status">正在{control==='PAUSING'?'暂停':'继续'}…</p>{control==='RESUMING'&&<button type="button" className="button secondary" disabled={busy} onClick={()=>void checkControl()}>核对状态</button>}</div>}
      </div>}
      <label>{running?'补充要求':'给 Agent 发消息'}<textarea value={instruction} disabled={Boolean(handoffPending||interruptedPause||control&&control!=='PAUSED')} onChange={event=>setInstruction(event.target.value)} placeholder={running?'在执行过程中补充信息或调整要求':'询问任务情况或讨论迁移方案'}/></label>
      <button type="button" className="button primary" disabled={sending||Boolean(handoffPending||interruptedPause||control&&control!=='PAUSED')||!instruction.trim()} onClick={()=>void sendInstruction()}>{control==='PAUSED'?'保存补充':'发送'}</button>
    </div>}
    {error&&<p role="alert">{error}</p>}
    {readError&&<p role="status">任务对话暂时无法读取，正在重试：{readError}</p>}
    </section>
    <aside className="task-products" aria-label="工作产物"><h3>工作产物</h3>
      {deliveryReview&&<p role="status">当前工作版本的独立源码审查：{({RECOMMEND:'建议继续交付验证',REVISE:'建议先修改',INCONCLUSIVE:'证据不足'} as const)[deliveryReview.decision]}。这不代表正式验收通过。</p>}
      {deliveryReview?.basicReview&&<article className="task-product"><h4>基础验证审查</h4>
        <p>{deliveryReview.basicEvidenceCurrent===false?'评测配置已变化，原证据仅供参考':deliveryReview.basicReview.status==='SUFFICIENT'?'所述范围已有证据':'所述范围证据不足'}：{deliveryReview.basicReview.scope}</p>
        <p>{deliveryReview.basicEvidenceCurrent===false?'验证条件变化后，需要重新确认任务范围。':deliveryReview.basicReview.coversTaskScope===true?'独立审查认为已覆盖用户选定的基础验证范围。':'尚未确认覆盖全部选定的基础验证范围。'}</p>
        <p>{deliveryReview.basicReview.reason}</p><small>该结论仅适用于当前文件版本和所述范围；效果评测单独进行。</small>
      </article>}
      {effectReview&&<article className="task-product"><h4>独立效果审查</h4>
        {effectReview.configurationCurrent===false&&<p role="status">评测配置已变化，原审查仅供参考。</p>}
        {effectReview.scopeCurrent===false&&<p role="status">任务范围已变化或原范围未记录，原审查仅供参考。</p>}
        <p>目标：{effectReview.goal}</p><p>{effectReview.decision.reason}</p>
        <small>基于所选开发集；不代表基础验证或正式验收通过。</small>
      </article>}
      {!products.size&&<p>迁移方案、优化目标等产物会随任务进展显示在这里。</p>}
      {[...products.entries()].map(([id,versions])=>{
        const latest=versions[versions.length-1]!;
        return <article key={id} className="task-product"><h4>{latest.title}</h4>
          {latest.workspaceDigest&&<p>{latest.workspaceDigest===(task.candidates.find(item=>item.id===task.currentCandidateId)?.digest??task.source.digest)
            ?latest.reviewStability==='frozen'?'审查使用的冻结文件与当前版本一致。':'审查开始和结束时的文件摘要与当前版本一致。':'审查所依据的文件与当前版本不同，请重新核对。'}审查建议不代表正式验收。</p>}
          {latest.reviewStability==='changed'&&<p>审查期间工作文件发生变化，请对最终版本重新审查。</p>}
          {latest.reviewStability==='unverified'&&<p>未能核对审查前后的工作文件，请重新审查。</p>}
          <MarkdownContent content={latest.content}/>
          {versions.length>1&&<details><summary>查看历史版本（{versions.length-1}）</summary>
            {versions.slice(0,-1).reverse().map(version=><section key={version.sequence}>
              <h5>{version.title}</h5><MarkdownContent compact content={version.content}/>
            </section>)}
          </details>}
        </article>;
      })}
    </aside></div>
  </section>;
}
