import { useState } from "react";
import { Activity, Plus, ServerCog, Pencil, Trash2, Save } from "lucide-react";
import { api } from "../../api-client";
import type { Catalog, Environment, EnvironmentInspection } from "../../types";

function runtimeTypeLabel(value: Environment["runtimeType"]): string {
  if (value === "openjiuwen") return "OpenJiuwen";
  if (value === "ea") return "EA Runtime";
  return "通用 HTTP Runtime";
}

export function EnvironmentView({ catalog, onChanged }: { catalog: Catalog; onChanged(): Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState<{
    name: string;
    type: "runtime_http" | "mcp_streamable_http";
    runtimeType: "openjiuwen" | "ea" | "generic_http";
    endpoint: string;
    credentialEnv: string;
    mcpEnvironmentIds: string[];
  }>({ name: "", type: "runtime_http", runtimeType: "openjiuwen", endpoint: "", credentialEnv: "", mcpEnvironmentIds: [] });
  const [result, setResult] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const runtimeEnvironments = catalog.environments.filter(item => item.type === "runtime_http");
  const mcpEnvironments = catalog.environments.filter(item => item.type === "mcp_streamable_http");
  const create = async () => {
    setSaving(true);
    setError("");
    try {
      await api(editingId ? `/api/environments/${editingId}` : "/api/environments", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify({
          ...form,
          runtimeType: form.type === "runtime_http" ? form.runtimeType : null,
          credentialEnv: form.credentialEnv || null,
          mcpEnvironmentIds: form.type === "runtime_http" ? form.mcpEnvironmentIds : [],
        }),
      });
      setForm({ name: "", type: "runtime_http", runtimeType: "openjiuwen", endpoint: "", credentialEnv: "", mcpEnvironmentIds: [] });
      setEditingId(null);
      setAdding(false);
      setResult({});
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  };
  const edit = (environment: Environment) => {
    setError("");
    setEditingId(environment.environmentId);
    setForm({ name: environment.name, type: environment.type, runtimeType: environment.runtimeType ?? "generic_http",
      endpoint: environment.endpoint, credentialEnv: environment.credentialEnv ?? "", mcpEnvironmentIds: [...environment.mcpEnvironmentIds] });
    setAdding(true);
  };
  const remove = async (environment: Environment) => {
    if (!window.confirm(`删除环境「${environment.name}」？历史报告不会删除。`)) return;
    setSaving(true); setError("");
    try {
      await api(`/api/environments/${environment.environmentId}`, { method: "DELETE" });
      if (editingId === environment.environmentId) { setEditingId(null); setAdding(false); }
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const toggleMcp = (environmentId: string) => setForm(current => ({
    ...current,
    mcpEnvironmentIds: current.mcpEnvironmentIds.includes(environmentId)
      ? current.mcpEnvironmentIds.filter(id => id !== environmentId)
      : [...current.mcpEnvironmentIds, environmentId],
  }));
  const preflight = async (environment: Environment) => {
    setResult(current => ({ ...current, [environment.environmentId]: "检测中" }));
    try {
      const value = await api<EnvironmentInspection>(`/api/environments/${environment.environmentId}/preflight`, { method: "POST" });
      setResult(current => ({
        ...current,
        [environment.environmentId]: value.status === "ready"
          ? environment.type === "mcp_streamable_http" ? `已连通 · 1 个 MCP 服务 · ${value.toolCount} 个工具` : `就绪 · ${value.mcpServers.length} 个 MCP 绑定 · ${value.toolCount} 个可用工具`
          : value.error || "预检失败",
      }));
    } catch (cause) {
      setResult(current => ({ ...current, [environment.environmentId]: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const renderEnvironment = (environment: Environment) => <div className="asset-row environment-row" key={environment.environmentId}>
    <div className="asset-icon"><ServerCog size={20} /></div>
    <div><strong>{environment.name}</strong><small>{environment.type === "runtime_http" ? `${runtimeTypeLabel(environment.runtimeType)} · ${environment.mcpEnvironmentIds.length} 个 MCP 绑定` : "MCP Streamable HTTP"}</small><p className="mono">{environment.endpoint}</p>{result[environment.environmentId] ? <em>{result[environment.environmentId]}</em> : null}</div>
    <div className="asset-actions">
    <button className="button secondary" onClick={() => preflight(environment)}><Activity size={16} />环境预检</button>
    <button className="icon-button" title={`编辑 ${environment.name}`} disabled={saving} onClick={() => edit(environment)}><Pencil size={16} /></button>
    <button className="icon-button" title={`删除 ${environment.name}`} disabled={saving} onClick={() => void remove(environment)}><Trash2 size={16} /></button>
    </div>
  </div>;
  return <div className="workspace"><section className="workspace-header"><div><span className="eyebrow">RUNTIME & CAPABILITY ENVIRONMENTS</span><h1>测试环境</h1><p>运行环境与业务能力分开配置，共用同一套模拟业务快照。</p></div><button className="button secondary" disabled={saving} onClick={()=>{setEditingId(null);setError("");setForm({name:"",type:"runtime_http",runtimeType:"openjiuwen",endpoint:"",credentialEnv:"",mcpEnvironmentIds:[]});setAdding(true);}}><Plus size={16}/>添加环境</button></section>
    {error ? <div className="info-banner" role="alert">{error}</div> : null}
    {adding ? <section className="environment-form">
      <label className="field"><span>环境名称</span><input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="OpenJiuwen 评测 Runtime" /></label>
      <label className="field"><span>资源类型</span><select disabled={Boolean(editingId)} value={form.type} onChange={event => setForm({ ...form, type: event.target.value as typeof form.type })}><option value="runtime_http">Agent Runtime</option><option value="mcp_streamable_http">MCP 服务</option></select></label>
      {form.type === "runtime_http" ? <label className="field"><span>Runtime 类型</span><select value={form.runtimeType} onChange={event => setForm({ ...form, runtimeType: event.target.value as typeof form.runtimeType })}><option value="openjiuwen">OpenJiuwen</option><option value="ea">EA Runtime</option><option value="generic_http">通用 HTTP Runtime</option></select></label> : null}
      <label className="field wide"><span>服务地址</span><input value={form.endpoint} onChange={event => setForm({ ...form, endpoint: event.target.value })} placeholder={form.type === "runtime_http" ? "https://agent.example.com/eval/execute" : "https://mcp.example.com/mcp"} /></label>
      <label className="field"><span>凭据环境变量</span><input value={form.credentialEnv} onChange={event => setForm({ ...form, credentialEnv: event.target.value })} placeholder="可选，只填写变量名" /></label>
      {form.type === "runtime_http" && mcpEnvironments.length ? <div className="mcp-binding-field"><span>关联 MCP（按需注册）</span><div>{mcpEnvironments.map(item => <label key={item.environmentId}><input type="checkbox" checked={form.mcpEnvironmentIds.includes(item.environmentId)} onChange={() => toggleMcp(item.environmentId)} />{item.name}</label>)}</div></div> : null}
      <button className="button primary" onClick={create} disabled={saving || !form.name.trim() || !form.endpoint}><Save size={17} />{saving ? "保存中" : editingId ? "保存修改" : "添加环境"}</button>
      <button className="button secondary" disabled={saving} onClick={()=>{setAdding(false);setEditingId(null);}}>取消</button>
    </section> : null}
    <section className="asset-section"><div className="section-title"><div><h2>Agent Runtime</h2><p>运行模型与 Skill，连接已绑定的 MCP，返回本轮运行证据。</p></div><span>{runtimeEnvironments.length} 个</span></div><div className="asset-table">{runtimeEnvironments.length ? runtimeEnvironments.map(renderEnvironment) : <div className="empty-table">尚未登记 Agent Runtime</div>}</div></section>
    <section className="asset-section"><div className="section-title"><div><h2>MCP 与能力服务</h2><p>Runtime 只注册本轮已绑定的服务；凭据始终由服务端环境变量提供。</p></div><span>{mcpEnvironments.length} 个</span></div><div className="asset-table">{mcpEnvironments.length ? mcpEnvironments.map(renderEnvironment) : <div className="empty-table">尚未登记 MCP 服务</div>}</div></section>
  </div>;
}
