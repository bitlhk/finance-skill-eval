import {useState} from 'react';
import {Check,Link2} from 'lucide-react';
import type {NativeBindingTarget} from '../../src/shared/contracts/native-tool-catalog';
import type {MigrationRuntime} from './types';

type Api=<T>(url:string,init?:RequestInit)=>Promise<T>;
export function NativeToolBinding({api,projectId,baseAssetId,tools,runtimes,done}:{api:Api;projectId:string;baseAssetId:string;
  tools:string[];runtimes:MigrationRuntime[];done:()=>Promise<void>}){
  const [selected,setSelected]=useState<string[]>([]),[targets,setTargets]=useState<NativeBindingTarget[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false);
  const missing=tools.filter(name=>targets.some(t=>!t.catalog.contracts.some(c=>c.nativeToolNames.length===1&&c.nativeToolNames[0]===name)));
  async function inspect(){setBusy(true);setError('');setConfirmed(false);setTargets([]);try{
    const values=[];for(const id of selected)values.push(await api<NativeBindingTarget>(`/api/migrations/${projectId}/native-tools?environmentId=${encodeURIComponent(id)}`));
    setTargets(values);
  }catch(e){setError(String(e))}finally{setBusy(false)}}
  async function bind(){setBusy(true);setError('');try{
    await api(`/api/migrations/${projectId}/native-candidate`,{method:'POST',body:JSON.stringify({baseAssetId,tools,acknowledgeContracts:true,
      targets:targets.map(t=>({environmentId:t.environmentId,catalogDigest:t.catalog.catalogDigest}))})});
    await done();
  }catch(e){setError(String(e))}finally{setBusy(false)}}
  return <section className="stage-section"><div className="stage-section-heading"><h3><Link2 size={18}/>复用已准入工具</h3></div>
    <p>适用于方法与声明文件。复用受管 Harness 工具，不生成银行实现，不授予业务权限。</p>
    <fieldset disabled={busy}><legend>目标 Runtime</legend>{runtimes.filter(r=>['openjiuwen','agentscope'].includes(r.runtimeType)).map(r=><label key={r.runtimeId}>
      <input type="checkbox" checked={selected.includes(r.runtimeId)} onChange={e=>{setSelected(old=>e.target.checked?[...old,r.runtimeId]:old.filter(id=>id!==r.runtimeId));setTargets([]);setConfirmed(false)}}/>{r.name}
    </label>)}</fieldset>
    <button className="button secondary" disabled={busy||!selected.length||selected.length>2} onClick={()=>void inspect()}>检查已准入合同</button>
    {targets.length>0&&<><p>{missing.length?`待接入工具：${missing.join('、')}`:tools.length?'所选环境均有对应工具，请核对其真实合同与使用范围。':'未发现业务工具依赖；必须有明确的空工具声明。候选仍需通过目标环境的安装和执行核验。'}</p>
      {targets.map(t=><details className="stage-detail" key={t.environmentId}><summary>{t.catalog.runtime.type} {t.catalog.runtime.version} · 工具合同</summary>
        {t.catalog.contracts.filter(c=>c.nativeToolNames.some(n=>tools.includes(n))).map(c=><article key={c.capabilityId}><strong>{c.nativeToolNames.join('、')}</strong><p>{c.contract.semantics}</p>
          <pre>{JSON.stringify({input:c.contract.inputSchema,output:c.contract.outputSchema,constraints:c.constraints},null,2)}</pre><small>验证依据 {c.verificationSha256}</small></article>)}
        <small>目录 {t.catalog.catalogDigest}</small></details>)}
      <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{tools.length?'已核对工具合同和用途；绑定不代表候选已执行通过':'已核对方法不需要业务工具；绑定不代表候选已执行通过'}</label>
      <button className="button primary" disabled={busy||!confirmed||missing.length>0} onClick={()=>void bind()}><Check size={16}/>绑定并生成候选</button></>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
