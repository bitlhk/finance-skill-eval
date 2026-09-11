import { useEffect, useState } from 'react';
import { ArrowRightLeft, Download, Play, RefreshCw, Save, ChevronRight, FileCode2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { Catalog, SkillAsset, EvaluationJob } from './types';
import { OptimizationPanel } from './OptimizationPanel';
import { downloadApi } from './api-path';
import './migration.css';

type Project={id:string;name:string;source:SkillAsset;candidate:SkillAsset|null;candidateNotes:string;
  generation?:{candidateDigest:string;diff:Array<{path:string;operation:string;before:string;after:string}>}};
type Diagnosis={status:string;dependencyStatus:string;digest:string;
  coverage:Array<{path:string;status:string}>;findings:Array<{id:string;path:string;line:number;snippet:string;
    dependencyType:string;reason:string;impact:string;suggestion:string;confidence:string;layer:string}>;
  ai:{status:string;summary?:string;error?:string;retryable:boolean;suggestions?:Array<{findingId:string;explanation:string;nextStep:string}>}};
type Api=<T>(url:string,init?:RequestInit)=>Promise<T>;
type MigrationReport={verification?:{originalBaseline:string;targetExecution:string;candidateChanged:boolean;
  missingSource:Array<{path:string;line:number;reason:string}>;targetGaps:string[]};suites?:Array<{preparationId:string;summary:string}|null>;experiments:Array<{jobId:string;pair:string;execution:string;evidence:string;
  professionalAcceptance:string;migrationAcceptance:string;candidateDigest:string}>};
const steps=['上传','依赖诊断','迁移','验证','优化','发布'];
export function MigrationPanel({catalog,api,uploadedAsset,onUpload}:{catalog:Catalog;api:Api;uploadedAsset?:SkillAsset|null;onUpload?:()=>void}) {
  const [projects,setProjects]=useState<Project[]>([]),[project,setProject]=useState<Project|null>(null);
  const [source,setSource]=useState(''),[candidate,setCandidate]=useState(''),[notes,setNotes]=useState('');
  const [step,setStep]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [analysis,setAnalysis]=useState<unknown>(null),[report,setReport]=useState<MigrationReport|null>(null);
  const [diagnosis,setDiagnosis]=useState<Diagnosis|null>(null),[target,setTarget]=useState(''),[intent,setIntent]=useState('portable_method_and_adapters');
  const [diagnosticRefresh,setDiagnosticRefresh]=useState(0);
  const [draft,setDraft]=useState(''),[draftBase,setDraftBase]=useState('');
  const [suiteText,setSuiteText]=useState(''),[optimizationJob,setOptimizationJob]=useState<EvaluationJob|null>(null);
  const [suites,setSuites]=useState<Array<{preparationId:string;summary:string}>>([]);
  const [pair,setPair]=useState('AB'),[left,setLeft]=useState(''),[right,setRight]=useState('');
  const [pack,setPack]=useState(''),[model,setModel]=useState('');
  const [data,setData]=useState(''),[permissions,setPermissions]=useState(''),[original,setOriginal]=useState(''),[lock,setLock]=useState('');
  useEffect(()=>{api<Project[]>('/api/migrations').then(setProjects).catch(e=>setError(String(e)));},[api]);
  useEffect(()=>{if(!uploadedAsset)return;let disposed=false;setBusy(true);setError('');
    api<Project>('/api/migrations',{method:'POST',body:JSON.stringify({sourceAssetId:uploadedAsset.assetId,name:uploadedAsset.displayName+'迁移'})})
      .then(p=>{if(!disposed){update(p);setDiagnosis(null);setStep(1);}}).catch(e=>{if(!disposed)setError(String(e));}).finally(()=>{if(!disposed)setBusy(false);});
    return()=>{disposed=true;};
  },[uploadedAsset,api]);
  useEffect(()=>{if(!project)return;let disposed=false;let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{try{const d=await api<Diagnosis>(`/api/migrations/${project.id}/diagnosis`);
      if(disposed)return;setDiagnosis(d);if(d.ai.status==='RUNNING')timer=setTimeout(load,1500);
    }catch(e){if(!disposed)setError(String(e));}};void load();
    return()=>{disposed=true;clearTimeout(timer);};
  },[project?.id,api,diagnosticRefresh]);
  async function act(fn:()=>Promise<void>) {if(busy)return;setBusy(true);setError('');try{await fn();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  const post=<T,>(suffix:string,body:unknown={})=>api<T>(`/api/migrations${suffix}`,{method:'POST',body:JSON.stringify(body)});
  useEffect(()=>{let disposed=false;setSuites([]);setOptimizationJob(null);if(project)void api<MigrationReport>(`/api/migrations/${project.id}/report`).then(r=>{if(!disposed)setSuites((r.suites??[]).filter((s):s is {preparationId:string;summary:string}=>!!s));}).catch(e=>{if(!disposed)setError(String(e));});return()=>{disposed=true;};},[project?.id,api]);
  function select(p:Project|null){setProject(p);setCandidate(p?.candidate?.assetId??'');setNotes(p?.candidateNotes??'');setAnalysis(null);setDiagnosis(null);setReport(null);setDraft('');setDraftBase('');setPack('');setStep(p?1:0);}
  function update(p:Project){setProject(p);setSource(p.source.assetId);setCandidate(p.candidate?.assetId??'');setProjects(old=>[p,...old.filter(x=>x.id!==p.id)]);}
  const candidateOptions=project?.candidate&&!catalog.uploadedSkills.some(a=>a.assetId===project.candidate?.assetId)
    ? [...catalog.uploadedSkills,project.candidate]:catalog.uploadedSkills;
  const environments=catalog.environments.filter(e=>e.type==='runtime_http');
  const findingGroups=Object.values((diagnosis?.findings??[]).reduce<Record<string,Diagnosis['findings']>>((groups,f)=>{
    (groups[f.dependencyType]??=[]).push(f);return groups;
  },{}));
  async function compare(){
    if(!project?.candidate)return;
    const selectedModel=catalog.models.find(m=>JSON.stringify([m.providerId,m.modelId])===model);
    if(!selectedModel)throw new Error('请选择同一个执行模型');
    const assets=pair==='AB'?[project.source,project.candidate]:pair==='BC'?[project.candidate,project.candidate]:[project.source,project.candidate];
    const variant=(a:SkillAsset)=>({mode:'skill_version',skillId:a.skillId,version:a.version,artifactSha256:a.artifactSha256});
    await post(`/${project.id}/validate`,{pair,dataSnapshot:data,permissionBasis:permissions,sourceProjectRef:original,dependencyLockRef:lock,
      configuration:{...(pack.startsWith('prep:')?{preparationId:pack.slice(5)}:{packId:pack}),runtime:{type:'runtime_http',environmentId:left},judgeMode:'model',
        executionModel:{providerId:selectedModel.providerId,modelId:selectedModel.modelId,parameters:selectedModel.parameters},
        leftVariant:variant(assets[0]!),rightVariant:variant(assets[1]!),
        runtimeBindings:{left:{environmentId:left,skillAssetId:assets[0]!.assetId},right:{environmentId:pair==='AB'?left:right,skillAssetId:assets[1]!.assetId}}}});
    setReport(await api(`/api/migrations/${project.id}/report`));setStep(3);
  }
  async function download(){
    if(!project)return;
    await downloadApi(`/api/migrations/${project.id}/export`,`${project.id}-draft.zip`);
  }
  return <section className="migration-panel">
    <header><h2><ArrowRightLeft size={20}/> Skill 迁移</h2><span className="state-tag">{project?.candidate?'候选待验证':project?'依赖诊断':'待上传'}</span></header>
    <label>已有项目<select value={project?.id??''} onChange={e=>select(projects.find(p=>p.id===e.target.value)??null)} disabled={busy}><option value="">新建迁移</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <nav aria-label="迁移步骤">{steps.map((s,i)=><button key={s} className={step===i?'active':''} aria-current={step===i?'step':undefined} disabled={busy||(!project&&i>0)} onClick={()=>setStep(i)}>{i+1} {s}</button>)}</nav>
    {error&&<p role="alert">{error}</p>}
    {busy&&<p role="status">正在处理，请稍候…</p>}
    {step===0&&<div>{onUpload&&<button className="button primary" disabled={busy} onClick={onUpload}><FileCode2 size={16}/>上传并诊断</button>}
      <label>原始 Skill<select value={source} onChange={e=>setSource(e.target.value)} disabled={busy||!!project}><option value="">选择已导入资产</option>{catalog.uploadedSkills.map(a=><option key={a.assetId} value={a.assetId}>{a.displayName}@{a.version}</option>)}</select></label>{project?<p>{project.source.displayName} · {project.source.version}</p>:<button className="button primary" disabled={!source||busy} onClick={()=>void act(async()=>{const asset=catalog.uploadedSkills.find(a=>a.assetId===source)!;update(await post<Project>('',{sourceAssetId:source,name:asset.displayName+'迁移'}));setStep(1);})}><ArrowRightLeft size={16}/>开始诊断</button>}</div>}
    {step===1&&project&&<div>
      <h3>{!diagnosis?'正在分析文件':diagnosis.dependencyStatus==='EXPLICIT_BINDING'?'发现框架或宿主绑定':diagnosis.dependencyStatus==='UNKNOWN'?'材料不完整，暂不能判断全部依赖':'已检查范围未发现框架绑定'}</h3>
      {diagnosis&&<><div className="diagnostic-summary"><span><CheckCircle2 size={17}/>已检查 {diagnosis.coverage.length} 个文件</span><span><AlertTriangle size={17}/>{diagnosis.findings.filter(f=>f.layer==='UNKNOWN').length} 项材料缺口</span><span>业务正文保留</span></div>
        <p>AI 解释：{({RUNNING:'生成中',COMPLETE:'已生成（辅助建议）',NOT_CONFIGURED:'模型未配置',FAILED:'生成失败'} as Record<string,string>)[diagnosis.ai.status]}</p>
        {diagnosis.ai.summary&&<p>{diagnosis.ai.summary}</p>}{diagnosis.ai.error&&<p role="status">{diagnosis.ai.error}</p>}
        {diagnosis.ai.retryable&&<button className="button secondary" disabled={busy} onClick={()=>void act(async()=>{
          setDiagnosis(await post(`/${project.id}/diagnose`));setDiagnosticRefresh(n=>n+1);
        })}><RefreshCw size={16}/>重试 AI 解释</button>}
        {diagnosis.findings.length===0?<p>静态检查未发现绑定；尚未进行原生运行验证。</p>:findingGroups.map(group=>{const f=group[0]!;return <article className="diagnostic-finding" key={f.dependencyType}>
          <h4>{f.reason}</h4><p>{f.impact}</p><p><strong>处理建议：</strong>{f.suggestion}</p>
          <small>{f.layer==='HOST'?'宿主适配':f.layer==='BUSINESS'?'业务待确认':f.layer==='FORMAT'?'可规范化':f.layer==='UNKNOWN'?'需补材料':'代码需审阅'} · {group.length} 处证据</small>
          <details><summary>查看文件与行号</summary>{group.map(item=><div key={item.id}><p>{item.path}:{item.line} · {item.confidence}</p><pre>{item.snippet}</pre>
            {diagnosis.ai.suggestions?.filter(s=>s.findingId===item.id).map(s=><p key={s.findingId}>AI 建议：{s.explanation} {s.nextStep}</p>)}</div>)}</details>
        </article>;})}
        <details><summary>检查覆盖度</summary>{diagnosis.coverage.map(f=><p key={f.path}>{f.path} · {f.status}</p>)}</details>
      </>}
      <button className="button primary" disabled={busy||!diagnosis} onClick={()=>setStep(2)}>选择迁移目标<ChevronRight size={16}/></button>
    </div>}
    {step===2&&project&&<div>
      <div className="migration-fields"><label>目标运行环境<select value={target} onChange={e=>setTarget(e.target.value)} disabled={busy}><option value="">OpenJiuwen · 先生成待接线草稿</option>{environments.filter(e=>e.runtimeType==='openjiuwen').map(e=><option key={e.environmentId} value={e.environmentId}>{e.name}</option>)}</select></label>
        <label>迁移意图<select value={intent} onChange={e=>setIntent(e.target.value)} disabled={busy}><option value="portable_method_and_adapters">保留业务方法，提取中立声明与薄适配</option><option value="preserve_business_method">保留业务方法，生成接线审阅草稿</option></select></label></div>
      <button className="button primary" disabled={busy||!diagnosis} onClick={()=>void act(async()=>{
        const p=await post<Project>(`/${project.id}/generate`,{runtime:'openjiuwen',...(target?{environmentId:target}:{}),intent,baseAssetId:(project.candidate??project.source).assetId});
        update(p);setNotes(p.candidateNotes);setAnalysis(null);setDraft('');setReport(null);
      })}><FileCode2 size={16}/>{project.candidate?'重新生成候选':'生成迁移候选'}</button>
      {project.generation&&<><h3>生成时文件变更</h3><p>适配草稿尚未在本项目中编译或接入 Host，原业务语义未改写。</p>
        {project.generation.candidateDigest!==project.candidate?.artifactSha256&&<p role="status">当前候选已手工修改，以下保留生成时的差异，不代表当前全部改动。</p>}
        {project.generation.diff.map(f=><details key={f.path}><summary>{f.operation==='ADD'?'新增':'修改'} · {f.path}</summary><div className="migration-fields"><pre>{f.before||'原包无此文件'}</pre><pre>{f.after}</pre></div></details>)}</>}
      <details><summary>手工编辑与已有候选</summary><button className="button secondary" disabled={busy} onClick={()=>void act(async()=>{
      const result=await post<{source:string;candidate:string|null;project:Project}>(`/${project.id}/analyze`);
      setAnalysis(result);setDraft(result.candidate??result.source);setDraftBase((result.project.candidate??result.project.source).assetId);
    })}><RefreshCw size={16}/>检查文件与待补材料</button>
      <label>规范化候选<select value={candidate} disabled={busy} onChange={e=>setCandidate(e.target.value)}><option value="">选择单独导入的新版本</option>{candidateOptions.filter(a=>a.assetId!==project.source.assetId).map(a=><option key={a.assetId} value={a.assetId}>{a.displayName}@{a.version}</option>)}</select></label>
      <label>改写依据与未解决依赖<textarea value={notes} disabled={busy} onChange={e=>setNotes(e.target.value)} rows={4}/></label><button className="button primary" disabled={busy||!candidate||!notes.trim()} onClick={()=>void act(async()=>update(await post<Project>(`/${project.id}/candidates`,{assetId:candidate,notes})))}><Save size={16}/>保存候选引用</button>
      {analysis!=null&&<><label>候选方法正文<textarea rows={14} value={draft} onChange={e=>setDraft(e.target.value)} disabled={busy}/></label>
      <button className="button secondary" disabled={busy||!draft.trim()||!notes.trim()} onClick={()=>void act(async()=>{
        const next=await post<Project>(`/${project.id}/drafts`,{source:draft,notes,baseAssetId:draftBase,autoVersion:true});
        update(next);setDraftBase(next.candidate!.assetId);setCandidate(next.candidate!.assetId);
      })}><Save size={16}/>保存为新版本</button>
      <details><summary>依赖盘点</summary><pre>{JSON.stringify(analysis,null,2)}</pre></details></>}</details>
      <button className="button secondary" disabled={busy||!project.candidate} onClick={()=>void act(async()=>{setReport(await api(`/api/migrations/${project.id}/report`));setStep(3);})}>检查验证条件<ChevronRight size={16}/></button></div>}
    {step===3&&project&&<div><h3>迁移前后功能检查</h3>
      <button className="button secondary" disabled={busy} onClick={()=>void act(async()=>setReport(await api(`/api/migrations/${project.id}/report`)))}><RefreshCw size={16}/>检查验证条件</button>
      {report?.verification&&<><p>原始基线：未完成原生验证 · OpenJiuwen 目标：未完成原生验证</p>{report.verification.candidateChanged&&<p role="alert">候选已修改，旧版本验证不能用于当前版本。</p>}
        <h4>原工程负责人需补充</h4>{report.verification.missingSource.length?report.verification.missingSource.map((f,i)=><p key={i}>{f.path}:{f.line} · {f.reason}</p>):<p>未发现静态材料缺口；仍需原工程启动方式、运行结果和同条件测试数据。</p>}
        <h4>本项目接入开发需完成</h4>{report.verification.targetGaps.map(f=><p key={f}>{f}</p>)}</>}
      <details><summary>工程对照配置（已有兼容 Runtime）</summary><div className="migration-fields"><label>对照阶段<select value={pair} disabled={busy} onChange={e=>setPair(e.target.value)}><option>AB</option><option>BC</option><option>AC</option></select></label><label>固定题集<select value={pack} onChange={e=>setPack(e.target.value)}><option value="">选择题集</option>{suites.map(s=><option key={s.preparationId} value={'prep:'+s.preparationId}>{s.summary}</option>)}{catalog.evalPacks.filter(p=>p.targetSkillId===project.source.skillId).map(p=><option key={p.packId} value={p.packId}>{p.targetSkillId} / {p.packId}</option>)}</select></label>
      <label>左侧 Runtime<select value={left} onChange={e=>setLeft(e.target.value)}><option value="">选择原环境</option>{environments.map(e=><option value={e.environmentId} key={e.environmentId}>{e.name}</option>)}</select></label><label>右侧 Runtime<select disabled={pair==='AB'} value={pair==='AB'?left:right} onChange={e=>setRight(e.target.value)}><option value="">选择目标环境</option>{environments.map(e=><option value={e.environmentId} key={e.environmentId}>{e.name}</option>)}</select></label>
      <label>共同执行模型<select value={model} onChange={e=>setModel(e.target.value)}><option value="">选择模型</option>{catalog.models.map(m=><option value={JSON.stringify([m.providerId,m.modelId])} key={m.providerId+':'+m.modelId} disabled={!!m.availability&&m.availability!=='ready'}>{m.label??m.modelId}</option>)}</select></label></div>
      <details><summary>冻结条件与工程依据</summary><label>原工程提交 / 入口<input value={original} onChange={e=>setOriginal(e.target.value)}/></label><label>原依赖锁引用<input value={lock} onChange={e=>setLock(e.target.value)}/></label><label>数据快照引用<input value={data} onChange={e=>setData(e.target.value)}/></label><label>等价授权依据<input value={permissions} onChange={e=>setPermissions(e.target.value)}/></label></details>
      <p>AB 比较方法；BC 比较包含 Harness 的执行栈；AC 复核最终差异。填写引用不等于原生工程或授权已核验。</p>
      <details><summary>项目试卷</summary><label>试卷 JSON<textarea rows={8} value={suiteText} onChange={e=>setSuiteText(e.target.value)}/></label><button className="button secondary" disabled={busy||!suiteText.trim()} onClick={()=>void act(async()=>{
        const suite=await post<{preparationId:string;summary:string}>(`/${project.id}/suites`,JSON.parse(suiteText));
        setSuites(old=>[...old,suite]);setPack('prep:'+suite.preparationId);setSuiteText('');
      })}><Save size={16}/>冻结新试卷</button></details>
      <button className="button primary" disabled={busy||!project.candidate||!left||(!right&&pair!=='AB')||!pack||!model||!original||!lock||!data||!permissions} onClick={()=>void act(compare)}><Play size={16}/>运行成对实验</button></details></div>}
    {step===3&&project&&<div><button className="button secondary" disabled={busy} onClick={()=>void act(async()=>setReport(await api(`/api/migrations/${project.id}/report`)))}><RefreshCw size={16}/>刷新运行结果</button>
      {report?.experiments.map(run=><article className="migration-result" key={run.jobId}><h3>{run.pair} · {run.execution}</h3>
        <dl><dt>运行编号</dt><dd>{run.jobId}</dd><dt>加载证据</dt><dd>{run.evidence}</dd><dt>专业验收</dt><dd>{run.professionalAcceptance}</dd><dt>迁移验收</dt><dd>{run.migrationAcceptance}</dd></dl>
        {['queued','running','preparing','evaluating'].includes(run.execution)&&<button className="button secondary" disabled={busy} onClick={()=>void act(async()=>{
          await api(`/api/runs/${run.jobId}/cancel`,{method:'POST'});setReport(await api(`/api/migrations/${project.id}/report`));
        })}>取消实验</button>}
        {run.execution==='completed'&&<button className="button secondary" disabled={busy||!!project.generation} onClick={()=>void act(async()=>{setOptimizationJob(await api(`/api/runs/${run.jobId}`));setStep(4);})}>查看评价并优化</button>}</article>)}
      <details><summary>完整实验记录</summary><pre>{report?JSON.stringify(report,null,2):'尚未读取结果'}</pre></details></div>}
    {step===4&&project&&<div><h3>表达优化（可选）</h3><p>当前候选尚未取得原生迁移验证。优化不能代替迁移验证，也不是导出草稿的前置条件。</p>
      {optimizationJob&&<OptimizationPanel job={optimizationJob} migrationId={project.id} onCandidate={()=>void act(async()=>{
        const next=await api<Project>(`/api/migrations/${project.id}`);update(next);setNotes(next.candidateNotes);setOptimizationJob(null);setReport(await api(`/api/migrations/${project.id}/report`));
      })}/>}
      <button className="button secondary" onClick={()=>setStep(5)}>跳过优化<ChevronRight size={16}/></button></div>}
    {step===5&&project&&<div><h3>归档与发布（可选）</h3><p>尚未完成原生运行、依赖及业务验收，正式发布关闭。</p><button className="button secondary" disabled={busy||!project.candidate} onClick={()=>void act(download)}><Download size={16}/>导出候选草稿</button><p>草稿保留原文件和适配建议，不是已验证 Domain Pack；Builder 导入仍待验收。</p></div>}
  </section>;
}
