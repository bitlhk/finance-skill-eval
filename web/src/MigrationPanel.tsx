import { useEffect, useState } from 'react';
import { ArrowRightLeft, Download, Play, RefreshCw, Save } from 'lucide-react';
import type { Catalog, SkillAsset } from './types';
import './migration.css';

type Project={id:string;name:string;source:SkillAsset;candidate:SkillAsset|null;candidateNotes:string};
type Api=<T>(url:string,init?:RequestInit)=>Promise<T>;
type MigrationReport={experiments:Array<{jobId:string;pair:string;execution:string;evidence:string;
  professionalAcceptance:string;migrationAcceptance:string;candidateDigest:string}>};
const steps=['导入','依赖与改写','对照验证','差异与改进','发布装配'];
export function MigrationPanel({catalog,api}:{catalog:Catalog;api:Api}) {
  const [projects,setProjects]=useState<Project[]>([]),[project,setProject]=useState<Project|null>(null);
  const [source,setSource]=useState(''),[candidate,setCandidate]=useState(''),[notes,setNotes]=useState('');
  const [step,setStep]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [analysis,setAnalysis]=useState<unknown>(null),[report,setReport]=useState<MigrationReport|null>(null);
  const [draft,setDraft]=useState(''),[draftBase,setDraftBase]=useState('');
  const [pair,setPair]=useState('AB'),[left,setLeft]=useState(''),[right,setRight]=useState('');
  const [pack,setPack]=useState(''),[model,setModel]=useState('');
  const [data,setData]=useState(''),[permissions,setPermissions]=useState(''),[original,setOriginal]=useState(''),[lock,setLock]=useState('');
  useEffect(()=>{api<Project[]>('/api/migrations').then(setProjects).catch(e=>setError(String(e)));},[api]);
  async function act(fn:()=>Promise<void>) {if(busy)return;setBusy(true);setError('');try{await fn();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  const post=<T,>(suffix:string,body:unknown={})=>api<T>(`/api/migrations${suffix}`,{method:'POST',body:JSON.stringify(body)});
  function select(p:Project|null){setProject(p);setCandidate(p?.candidate?.assetId??'');setNotes(p?.candidateNotes??'');setAnalysis(null);setReport(null);setDraft('');setDraftBase('');setStep(0);}
  function update(p:Project){setProject(p);setSource(p.source.assetId);setCandidate(p.candidate?.assetId??'');setProjects(old=>[p,...old.filter(x=>x.id!==p.id)]);}
  const candidateOptions=project?.candidate&&!catalog.uploadedSkills.some(a=>a.assetId===project.candidate?.assetId)
    ? [...catalog.uploadedSkills,project.candidate]:catalog.uploadedSkills;
  const environments=catalog.environments.filter(e=>e.type==='runtime_http');
  async function compare(){
    if(!project?.candidate)return;
    const selectedModel=catalog.models.find(m=>JSON.stringify([m.providerId,m.modelId])===model);
    if(!selectedModel)throw new Error('请选择同一个执行模型');
    const assets=pair==='AB'?[project.source,project.candidate]:pair==='BC'?[project.candidate,project.candidate]:[project.source,project.candidate];
    const variant=(a:SkillAsset)=>({mode:'skill_version',skillId:a.skillId,version:a.version,artifactSha256:a.artifactSha256});
    await post(`/${project.id}/validate`,{pair,dataSnapshot:data,permissionBasis:permissions,sourceProjectRef:original,dependencyLockRef:lock,
      configuration:{packId:pack,runtime:{type:'runtime_http',environmentId:left},judgeMode:'model',
        executionModel:{providerId:selectedModel.providerId,modelId:selectedModel.modelId,parameters:selectedModel.parameters},
        leftVariant:variant(assets[0]!),rightVariant:variant(assets[1]!),
        runtimeBindings:{left:{environmentId:left,skillAssetId:assets[0]!.assetId},right:{environmentId:pair==='AB'?left:right,skillAssetId:assets[1]!.assetId}}}});
    setReport(await api(`/api/migrations/${project.id}/report`));setStep(3);
  }
  async function download(){
    if(!project)return;
    const token=localStorage.getItem('finance-eval-token');
    const response=await fetch(`/api/migrations/${project.id}/export`,{headers:token?{authorization:`Bearer ${token}`}:{}});
    if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.message??'候选导出失败');}
    const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');
    a.href=url;a.download=`${project.id}-draft.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <section className="migration-panel">
    <header><h2><ArrowRightLeft size={20}/> Skill 迁移</h2><span className="state-tag">候选实验 · 尚未验收</span></header>
    <label>已有项目<select value={project?.id??''} onChange={e=>select(projects.find(p=>p.id===e.target.value)??null)} disabled={busy}><option value="">新建迁移</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <nav aria-label="迁移步骤">{steps.map((s,i)=><button key={s} className={step===i?'active':''} aria-current={step===i?'step':undefined} disabled={busy||(!project&&i>0)} onClick={()=>setStep(i)}>{i+1} {s}</button>)}</nav>
    {error&&<p role="alert">{error}</p>}
    {step===0&&<div><label>原始 Skill<select value={source} onChange={e=>setSource(e.target.value)} disabled={busy||!!project}><option value="">选择已导入资产</option>{catalog.uploadedSkills.map(a=><option key={a.assetId} value={a.assetId}>{a.displayName}@{a.version}</option>)}</select></label>{project?<p className="mono">{project.source.skillId}@{project.source.version}<br/>SHA {project.source.artifactSha256}</p>:<button className="button primary" disabled={!source||busy} onClick={()=>void act(async()=>{const asset=catalog.uploadedSkills.find(a=>a.assetId===source)!;update(await post<Project>('',{sourceAssetId:source,name:asset.displayName+'迁移'}));})}><ArrowRightLeft size={16}/>建立迁移项目</button>}</div>}
    {step===1&&project&&<div><button className="button secondary" disabled={busy} onClick={()=>void act(async()=>{
      const result=await post<{source:string;candidate:string|null;project:Project}>(`/${project.id}/analyze`);
      setAnalysis(result);setDraft(result.candidate??result.source);setDraftBase((result.project.candidate??result.project.source).assetId);
    })}><RefreshCw size={16}/>检查文件与待补材料</button>
      <label>规范化候选<select value={candidate} disabled={busy} onChange={e=>setCandidate(e.target.value)}><option value="">选择单独导入的新版本</option>{candidateOptions.filter(a=>a.assetId!==project.source.assetId).map(a=><option key={a.assetId} value={a.assetId}>{a.displayName}@{a.version}</option>)}</select></label>
      <label>改写依据与未解决依赖<textarea value={notes} disabled={busy} onChange={e=>setNotes(e.target.value)} rows={4}/></label><button className="button primary" disabled={busy||!candidate||!notes.trim()} onClick={()=>void act(async()=>update(await post<Project>(`/${project.id}/candidates`,{assetId:candidate,notes})))}><Save size={16}/>保存候选引用</button>
      {analysis!=null&&<><label>候选方法正文<textarea rows={14} value={draft} onChange={e=>setDraft(e.target.value)} disabled={busy}/></label>
      <button className="button secondary" disabled={busy||!draft.trim()||!notes.trim()} onClick={()=>void act(async()=>{
        const next=await post<Project>(`/${project.id}/drafts`,{source:draft,notes,baseAssetId:draftBase});
        update(next);setDraftBase(next.candidate!.assetId);setCandidate(next.candidate!.assetId);
      })}><Save size={16}/>保存为新版本</button>
      <details><summary>依赖盘点</summary><pre>{JSON.stringify(analysis,null,2)}</pre></details></>}<p>上传脚本不执行。静态盘点不等于依赖验证，AI 改写接线尚待完成。</p></div>}
    {step===2&&project&&<div><div className="migration-fields"><label>对照阶段<select value={pair} disabled={busy} onChange={e=>setPair(e.target.value)}><option>AB</option><option>BC</option><option>AC</option></select></label><label>固定题集<select value={pack} onChange={e=>setPack(e.target.value)}><option value="">选择题集</option>{catalog.evalPacks.map(p=><option key={p.packId} value={p.packId}>{p.targetSkillId} / {p.packId}</option>)}</select></label>
      <label>左侧 Runtime<select value={left} onChange={e=>setLeft(e.target.value)}><option value="">选择原环境</option>{environments.map(e=><option value={e.environmentId} key={e.environmentId}>{e.name}</option>)}</select></label><label>右侧 Runtime<select disabled={pair==='AB'} value={pair==='AB'?left:right} onChange={e=>setRight(e.target.value)}><option value="">选择目标环境</option>{environments.map(e=><option value={e.environmentId} key={e.environmentId}>{e.name}</option>)}</select></label>
      <label>共同执行模型<select value={model} onChange={e=>setModel(e.target.value)}><option value="">选择模型</option>{catalog.models.map(m=><option value={JSON.stringify([m.providerId,m.modelId])} key={m.providerId+':'+m.modelId} disabled={!!m.availability&&m.availability!=='ready'}>{m.label??m.modelId}</option>)}</select></label></div>
      <details open><summary>冻结条件与工程依据</summary><label>原工程提交 / 入口<input value={original} onChange={e=>setOriginal(e.target.value)}/></label><label>原依赖锁引用<input value={lock} onChange={e=>setLock(e.target.value)}/></label><label>数据快照引用<input value={data} onChange={e=>setData(e.target.value)}/></label><label>等价授权依据<input value={permissions} onChange={e=>setPermissions(e.target.value)}/></label></details>
      <p>AB 比较方法；BC 比较包含 Harness 的执行栈；AC 复核最终差异。填写引用不等于原生工程或授权已核验。</p>
      <button className="button primary" disabled={busy||!project.candidate||!left||(!right&&pair!=='AB')||!pack||!model||!original||!lock||!data||!permissions} onClick={()=>void act(compare)}><Play size={16}/>运行成对实验</button></div>}
    {step===3&&project&&<div><button className="button secondary" disabled={busy} onClick={()=>void act(async()=>setReport(await api(`/api/migrations/${project.id}/report`)))}><RefreshCw size={16}/>刷新运行结果</button>
      {report?.experiments.map(run=><article className="migration-result" key={run.jobId}><h3>{run.pair} · {run.execution}</h3>
        <dl><dt>运行编号</dt><dd>{run.jobId}</dd><dt>加载证据</dt><dd>{run.evidence}</dd><dt>专业验收</dt><dd>{run.professionalAcceptance}</dd><dt>迁移验收</dt><dd>{run.migrationAcceptance}</dd></dl>
        {['queued','running','preparing','evaluating'].includes(run.execution)&&<button className="button secondary" disabled={busy} onClick={()=>void act(async()=>{
          await api(`/api/runs/${run.jobId}/cancel`,{method:'POST'});setReport(await api(`/api/migrations/${project.id}/report`));
        })}>取消实验</button>}</article>)}
      <details><summary>完整实验记录</summary><pre>{report?JSON.stringify(report,null,2):'尚未读取结果'}</pre></details><p>运行成功、专业评价、任务成功和迁移验收分别判定。详细轨迹沿用运行记录入口。</p></div>}
    {step===4&&project&&<div><p>原生 AgentScope 基线、Java Host 接线、依赖映射及业务验收尚未齐备，正式发布关闭。</p><button className="button secondary" disabled={busy||!project.candidate} onClick={()=>void act(download)}><Download size={16}/>导出候选草稿</button><p>草稿不是已验证 Domain Pack，也不是安装 Lock。Builder 导入兼容性待验收。</p></div>}
  </section>;
}
