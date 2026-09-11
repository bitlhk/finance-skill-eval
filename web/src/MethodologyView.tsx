import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Handle, Position, Controls, MarkerType, type NodeProps, type Node } from '@xyflow/react';
import { BookOpen, Files, GitCompareArrows, Bot, Database, ScanText, ChartNoAxesCombined, ExternalLink, type LucideIcon } from 'lucide-react';
import '@xyflow/react/dist/style.css';

type StageNode = Node<{ title: string; detail: string; icon: LucideIcon; tone?: string; vertical?: boolean }>;
function Stage({ data }: NodeProps<StageNode>) {
  const Icon = data.icon;
  return <div className={`flow-stage ${data.tone ?? ''}`}>
    <Handle type="target" position={data.vertical ? Position.Top : Position.Left} />
    <span className="flow-stage-icon"><Icon size={20} strokeWidth={1.6} /></span>
    <div><strong>{data.title}</strong><small>{data.detail}</small></div>
    <Handle type="source" position={data.vertical ? Position.Bottom : Position.Right} />
  </div>;
}
const nodeTypes = { stage: Stage };
const steps = [
  ['skill', 20, 140, 'Skill 与专业 SOP', '岗位目标 · 制品版本', BookOpen, ''],
  ['case', 290, 140, '共同试题与环境', '固定案例 / AI 候选题', Files, ''],
  ['left', 560, 45, 'A · 基线执行', '无 Skill / 原版本', Bot, 'baseline'],
  ['right', 560, 235, 'B · 对照执行', '目标 Skill / 候选版本', Bot, 'candidate'],
  ['judge', 830, 140, '匿名专业评阅', 'GPT-6 · 四维专业判断', ScanText, ''],
  ['report', 1100, 140, '对比报告', '差异 · 证据 · 优化建议', ChartNoAxesCombined, ''],
] as const;
const links = [
  ['Agent Skills', '技能制品与渐进加载', 'https://agentskills.io/specification'],
  ['Promptfoo', 'A/B 运行编排与报告基础', 'https://www.promptfoo.dev/docs/intro/'],
  ['OpenJiuwen', '实际执行 Agent 与工具', 'https://github.com/openjiuwen/agent-core'],
  ['MCP', '标准工具发现与调用', 'https://modelcontextprotocol.io/'],
];

export function MethodologyView() {
  const [mobile,setMobile]=useState(()=>window.innerWidth<=660);
  useEffect(()=>{const mq=window.matchMedia('(max-width:660px)');const change=()=>setMobile(mq.matches);mq.addEventListener('change',change);return()=>mq.removeEventListener('change',change);},[]);
  const nodes = useMemo<StageNode[]>(() => steps.map(([id,x,y,title,detail,icon,tone],i) => ({id,type:'stage',position:mobile?([{x:95,y:0},{x:95,y:115},{x:0,y:245},{x:190,y:245},{x:95,y:375},{x:95,y:490}][i]!):{x,y},style:{width:mobile?170:226},data:{title,detail,icon,tone,vertical:mobile}})),[mobile]);
  const edges = useMemo(() => [['skill','case'],['case','left'],['case','right'],['left','judge'],['right','judge'],['judge','report']].map(([source,target]) => ({id:`${source}-${target}`,source,target,type:'smoothstep',style:{stroke:target==='right'||source==='right'?'#c7202b':'#b1b1b6',strokeWidth:1.7},markerEnd:{type:MarkerType.ArrowClosed,color:target==='right'||source==='right'?'#c7202b':'#b1b1b6'}})),[]);
  return <div className="workspace methodology-view">
    <section className="workspace-header"><div><span className="eyebrow">EVALUATION METHODOLOGY</span><h1>评测方法</h1><p>同题、同模型、同环境，比较 Skill 带来的业务增益。</p></div><span className="method-label"><GitCompareArrows size={16}/>同条件 A/B</span></section>
    <section className="method-section">
      <div className="section-title"><h2>从业务任务到专业判断</h2><span>在线执行 · 独立评阅 · 可复核证据</span></div>
      <div className="flow-scroll"><div className="method-canvas" role="img" aria-label="Skill 和共同试题分流至 A、B 两侧 Agent 执行，经匿名 Judge 形成对比报告">
        <ReactFlow key={String(mobile)} nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{padding:.06}} minZoom={.6} maxZoom={1.3} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll={false} preventScrolling={false} ariaLabelConfig={{'controls.zoomIn.ariaLabel':'放大流程','controls.zoomOut.ariaLabel':'缩小流程','controls.fitView.ariaLabel':'适应画布'}}>
          <Controls showInteractive={false}/>
        </ReactFlow>
      </div></div>
      <div className="method-shared"><Database size={18}/><strong>共同业务环境</strong><span>OpenJiuwen 按本题需求连接 MCP；业务数据为固定模拟快照，答案由模型现场生成。</span></div>
    </section>
    <section className="method-section quality-method">
      <div className="section-title"><h2>评价重点</h2><span>不以篇幅、字段数量或“装配成功”代替质量</span></div>
      <div className="quality-criteria">
        <div><span>01</span><strong>专业判断</strong><p>证据是否支持结论，是否识别真正影响业务决策的矛盾。</p></div>
        <div><span>02</span><strong>业务完整性</strong><p>关键条件、方案取舍、风险与缺口是否完整。</p></div>
        <div><span>03</span><strong>表达清晰度</strong><p>是否自然、易懂，能直接用于真实工作沟通。</p></div>
        <div><span>04</span><strong>可执行性</strong><p>是否帮助使用者作出选择，并形成明确下一步。</p></div>
      </div>
      <div className="method-footnote">AI Judge 是专业质量参考，不等同于独立人类专家签署。冻结证据回放会单独标记，不冒充本轮在线执行。</div>
    </section>
    <section className="method-section"><div className="section-title"><h2>实现与开放规范</h2></div><div className="method-links">{links.map(([name,detail,href])=><a href={href} target="_blank" rel="noreferrer" key={name}><span><strong>{name}</strong><small>{detail}</small></span><ExternalLink size={16}/></a>)}</div></section>
  </div>;
}
