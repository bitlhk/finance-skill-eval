import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { EvaluationJob } from "./types";

export function ResultCharts({ report }: { report: NonNullable<EvaluationJob["report"]> }) {
  const valid = report.cases.filter(c => c.judge && c.left.status === "completed" && c.right.status === "completed");
  if (!valid.length) return <div className="info-banner">没有已完成的专业评分，暂不绘制分数图。</div>;
  const ids = [...new Set(valid.flatMap(c => c.judge!.dimensions.map(d => d.id)))];
  const axisLabels: Record<string, string> = { professional_fit: "专业匹配", business_completeness: "业务完整", clarity: "结构表达", actionability: "可执行性" };
  const data = ids.map(id => {
    const dims = valid.flatMap(c => c.judge!.dimensions.filter(d => d.id === id));
    return { name: dims[0]!.label, axisName: axisLabels[id] ?? dims[0]!.label, A: Number((dims.reduce((s,d) => s + d.leftScore, 0) / dims.length).toFixed(2)), B: Number((dims.reduce((s,d) => s + d.rightScore, 0) / dims.length).toFixed(2)) };
  });
  const metrics = (["left", "right"] as const).map(side => {
    const evidence = report.cases.map(c => c[side]);
    const done = evidence.filter(e => e.status === "completed");
    const tokens = done.every(e => typeof e.usage?.totalTokens === "number") ? done.reduce((sum,e) => sum + e.usage!.totalTokens!, 0).toLocaleString() : "未提供";
    return { side, completed: done.length, seconds: done.length ? (done.reduce((s,e) => s + e.elapsedMs, 0) / done.length / 1000).toFixed(1) : "-", tokens };
  });
  return <section className="result-charts">
    <div className="chart-header"><h3>专业质量对比</h3><span>0–4 分 · {valid.length} 个已评分样本 · 未评阅不计零分</span></div>
    <div className="quality-chart" role="img" aria-label={data.map(d => `${d.name} A ${d.A} B ${d.B}`).join("，")}>
      <ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 12, right: 12, bottom: 12, left: -24 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
        <XAxis dataKey="name" tickFormatter={name => data.find(d => d.name === name)?.axisName ?? name} tick={{ fontSize: 12 }} interval={0} /><YAxis domain={[0,4]} ticks={[0,1,2,3,4]} tick={{ fontSize: 12 }} />
        <Tooltip /><Legend /><Bar name="A · 对照" dataKey="A" fill="#8c98a9" maxBarSize={42} isAnimationActive={false} /><Bar name="B · 目标" dataKey="B" fill="#bd292d" maxBarSize={42} isAnimationActive={false} />
      </BarChart></ResponsiveContainer>
    </div>
    <div className="runtime-metrics">{metrics.map(m => <div key={m.side}><b>{m.side === "left" ? "A · 对照" : "B · 目标"}</b><span>完成 {m.completed}/{report.cases.length}</span><span>平均 {m.seconds}s</span><span>Token {m.tokens}</span></div>)}</div>
  </section>;
}
