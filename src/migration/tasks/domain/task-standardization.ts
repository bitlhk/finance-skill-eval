import {z} from 'zod';
import {evidenceIssues,reuseDesignSchema} from '../../domain/migration-reuse-design.js';
import type {TaskDiagnosis} from './task-diagnosis.js';
import {runtimeInputSchema,runtimeInputGroupSchema} from './task-runtime-inputs.js';

const text=z.string().trim().min(1);
const evidence=z.object({path:text,snippet:text});
const form=z.enum(['SCRIPT','MCP']);
export const standardizationSchema=z.object({
  version:z.literal('enterprise-standardization.v1'),
  configurationInputs:z.array(runtimeInputSchema).optional(),
  configurationGroups:z.array(runtimeInputGroupSchema).optional(),
  coverage:z.object({readPaths:z.array(text),gaps:z.array(z.object({path:text,reason:text,blocking:z.boolean()}))}),
  requirements:z.array(z.object({id:text,kind:z.enum(['BUSINESS','RUNTIME']),statement:text,
    toolIds:z.array(text),memberIds:z.array(text),evidence:z.array(evidence).min(1)})).min(1),
  tools:z.array(z.object({toolId:text,form,action:z.enum(['KEEP','ADAPT','CONVERT']),
    alternatives:z.array(z.object({form,feasible:z.boolean(),reason:text,changeCost:text,deploymentCost:text,maintenanceCost:text})).length(2),
    recommendation:text,assumptions:z.array(text),
    contract:z.object({inputSchema:z.record(z.unknown()),outputSchema:z.record(z.unknown()),
      errors:text,state:text,configuration:text,invocation:text,
      sampleInput:z.record(z.unknown()).nullable(),sampleReason:text}),
  })),
});
export const deliveredToolSchema=z.object({toolId:text,form,entrypoint:text,files:z.array(text).min(1),
  invocation:text,configuration:text});
export const conformanceSchema=z.object({
  checks:z.array(z.object({requirementId:text,status:z.enum(['CONFORMING','NEEDS_CHANGES','UNKNOWN']),reason:text,
    evidence:z.array(evidence)})),
  issues:z.array(text),
});
export const contractEvidenceSchema=z.object({toolId:text,passed:z.boolean(),callExecuted:z.boolean(),detail:text});
export type Standardization=z.infer<typeof standardizationSchema>;
type StandardAnalysis={standardization?:Standardization;diagnosis?:TaskDiagnosis;plan?:z.infer<typeof reuseDesignSchema>;missing:string[]};
type StandardDelivery={summary?:string;tools?:Array<z.infer<typeof deliveredToolSchema>>;conformance?:z.infer<typeof conformanceSchema>;services:Array<{toolNames:string[]}>};

export const enterprisePolicy=[
  '目标是一次企业标准化、跨框架快速复用，不是改成某个目标 Agent 框架的应用。只做消除复用障碍的必要修改。',
  'Skill 的业务流程、决策、失败处理、工具协作和输出要求不得缩水；Tool 的业务算法、输入输出语义、错误、副作用和必要状态保持。包装改变必须说明映射并同步 Skill。',
  '禁止把原框架的配置/Session/Context/返回对象换成目标框架私有对象；安装原 Agent SDK 不能代替解耦。普通业务库可保留，不能按库名机械删除。',
  'Script/MCP 是推荐的通用调用形式。先比较可行性，再比较改造、部署及长期维护成本；已符合要求优先保留。无服务需求且成本相近时优先简单 Script；已有共享服务设施时 MCP 可能成本更低。不要虚构部署事实、费用或工时。',
  '形式 form 与改造 action 分开。Script 可以远程调用；有状态不自动要求 MCP。不为了包装成服务而大规模重写。CLI 只识别预装要求，本期不新增专用适配。',
  'Script 推荐 stdin 一个 JSON object / stdout 一个 JSON value，日志 stderr；原工具已经返回的业务、配置、HTTP 和解析错误均保留对调用方可见的含义、消息与结果结构。不得将原有错误结果改成只有 stderr 或非零退出码；新增脚本协议错误才单独定义退出码，包装映射必须明确。声明脚本入口、解释器、依赖、cwd 和资源路径。',
  'MCP 声明真实工具名称、输入 Schema、输出/错误契约、连接启动和配置。当前验证服务支持 Streamable HTTP /mcp 与 PORT，这是接入约定，不是业务依赖。',
  'inputSchema/outputSchema 必须覆盖实际调用边界及所有合法分支：若成功返回对象而原错误返回字符串，用 anyOf 等准确表达，不能只在 description 写错误。源码透传的未知数据不得擅自限制为 array/object；脚本分发信封与业务参数应在 invocation 中明确区分，不能误把额外收紧的类型当成原业务契约。',
  '业务参数与运行配置、凭证、按调用身份分离；不得让模型猜测凭证或选择身份。环境变量可提供明确的进程配置，不能用可变全局变量模拟多租户调用身份。',
  '先提取有源码证据的原业务基线，再设计迁移；不能用自己生成的方案反证原需求。未知契约如实记录，关键业务未知阻止实施；缺实际凭证只阻止有关运行验证。',
  '同一份工程统一分析所有 Skill 和共享工具；共享工具只列一次，保留成员调用关系。不要编造不存在的 workflow。',
  '每项业务或运行要求均有稳定 id，plan.acceptanceChecks 使用完全相同的 id；测试证据必须逐项对应。源码审查不是运行证明，启动/编译成功不是工具真实调用成功。',
  'contract.sampleInput 只能是源中有依据、无外部写入副作用的安全调用示例；没有这样的示例填 null 并解释。不得自动预订、取消、修改真实业务，不得伪造成功或固定测试答案。',
  '独立检查在包自身声明的依赖环境执行，不继承平台 Agent 环境。Python 优先复用语言并声明 pyproject.toml 或 PEP 723 依赖；不要打包 .venv。',
  '需要用户补充的服务地址、模型配置等在 configurationInputs 声明 name/label/description/required/sensitive/toolIds。name 是工具读取的环境变量名；不得填值。凭证 sensitive=true，由使用者引用已有安全配置。缺少值不阻止诊断或生成，只阻止有关运行验证。按调用身份不得改为进程配置。',
  '有主配置/回退配置或其他任选关系时，不得将可替代字段都标成 required。将这些字段 required=false，并用 configurationGroups:[{label:"所需配置",alternatives:[["一组必须同时提供的变量"],["另一完整可选组"]]} 表达至少满足一组；按源码的实际回退条件分组，不擅自把整组回退改为逐字段回退。',
  '原业务基线必须同时覆盖每个 SKILL.md 的智能体行为与工具实现，不能只提取工具算法。逐项核对触发/追问、步骤顺序、工具调用次数、多个输入协作、结果呈现、失败处理及隐私提示等原文要求；requirements 与 acceptanceChecks 中都应有可追踪条目。',
];
export const standardizationExample={
  version:'enterprise-standardization.v1',configurationInputs:[],configurationGroups:[],coverage:{readPaths:['真实读取的全部业务文件'],gaps:[]},
  requirements:[{id:'check-1',kind:'BUSINESS',statement:'一项原业务要求；另用 RUNTIME 条目列具体运行前提',toolIds:['tool-1'],memberIds:[],evidence:[{path:'真实源文件',snippet:'原文'}]}],
  tools:[{toolId:'tool-1',form:'SCRIPT',action:'ADAPT',alternatives:[
    {form:'SCRIPT',feasible:true,reason:'结合实际使用方式',changeCost:'需要的具体修改与风险',deploymentCost:'依赖安装与分发条件',maintenanceCost:'升级与维护工作'},
    {form:'MCP',feasible:true,reason:'是否需要共享服务',changeCost:'需要的具体修改与风险',deploymentCost:'服务部署与已有设施',maintenanceCost:'服务维护工作'}],
    recommendation:'比较两者后给出依据',assumptions:[],contract:{inputSchema:{type:'object',properties:{}},outputSchema:{},errors:'原业务错误与包装映射',state:'实际状态与隔离语义',configuration:'明确依赖配置来源，不填值',invocation:'实际标准调用约定',sampleInput:null,sampleReason:'没有无副作用样例时的原因'}}],
};

/** Validate identity, coverage and evidence without pretending that text matching proves semantics. */
export function standardizationIssues(analysis:StandardAnalysis, files:Record<string,string>):string[]{
  const standard=analysis.standardization;if(!standard)return [];
  const issues:string[]=[],diagnosis=analysis.diagnosis,plan=analysis.plan;
  if(!diagnosis||!plan)return ['标准化方案缺少诊断或实施方案'];
  const textFiles=Object.fromEntries(Object.entries(files).map(([p,b])=>[p,Buffer.from(b,'base64').toString('utf8')]));
  const unique=(ids:string[])=>new Set(ids).size===ids.length;
  const reqIds=standard.requirements.map(r=>r.id),toolIds=diagnosis.tools.map(t=>t.id);
  const inputs=standard.configurationInputs??[];
  if(!unique(inputs.map(i=>i.name))||inputs.some(i=>i.toolIds.some(id=>!toolIds.includes(id))))issues.push('运行配置声明存在重复名称或未知工具');
  for(const group of standard.configurationGroups??[]){
    if(group.alternatives.some(option=>!unique(option)||option.some(name=>!inputs.some(i=>i.name===name))))issues.push('运行配置组合引用了未声明或重复的配置');
    const names=new Set(group.alternatives.flat());
    if(inputs.some(i=>names.has(i.name)&&i.required&&!group.alternatives.every(option=>option.includes(i.name))))issues.push('可替代的运行配置不能同时声明为单独必填');
  }
  if(!unique(reqIds)||!unique(standard.tools.map(t=>t.toolId)))issues.push('标准化要求或工具标识重复');
  if(plan.acceptanceChecks.length!==reqIds.length||plan.acceptanceChecks.some(c=>!reqIds.includes(c.id)))issues.push('验收要求必须逐项对应原业务与运行要求');
  if(standard.tools.length!==toolIds.length||standard.tools.some(t=>!toolIds.includes(t.toolId)))issues.push('工具选型未完整对应诊断工具');
  for(const item of standard.tools){
    if(new Set(item.alternatives.map(a=>a.form)).size!==2)issues.push(`${item.toolId} 缺少 Script/MCP 成本比较`);
    if(!item.alternatives.some(a=>a.form===item.form&&a.feasible))issues.push(`${item.toolId} 推荐了不可行形式`);
    if(diagnosis.tools.find(t=>t.id===item.toolId)?.targetForm!==item.form)issues.push(`${item.toolId} 诊断与选型形式不一致`);
    if(!standard.requirements.some(r=>r.kind==='BUSINESS'&&r.toolIds.includes(item.toolId)))issues.push(`${item.toolId} 缺少原业务基线`);
  }
  for(const r of standard.requirements){
    if(r.toolIds.some(id=>!toolIds.includes(id)))issues.push(`${r.id} 引用了未知工具`);
    issues.push(...evidenceIssues(r.evidence,textFiles));
  }
  const accounted=new Set([...standard.coverage.readPaths,...standard.coverage.gaps.map(g=>g.path)]);
  if(Object.keys(files).some(p=>!accounted.has(p))||[...accounted].some(p=>!(p in files)))issues.push('源码分析覆盖清单不完整或包含不存在的路径');
  if(standard.coverage.gaps.some(g=>g.blocking)&&!analysis.missing.length)issues.push('阻塞的分析缺口未列入待补充信息');
  if(plan.changes.some(c=>c.toolNames.some(n=>!diagnosis.tools.some(t=>t.name===n))))issues.push('改造项引用了未知工具');
  return issues;
}
export function standardDeliveryIssues(analysis:StandardAnalysis, delivery:StandardDelivery, files:Record<string,string>):string[]{
  const standard=analysis.standardization;if(!standard)return [];
  const issues:string[]=[],tools=delivery.tools??[];
  if(tools.length!==standard.tools.length||new Set(tools.map(t=>t.toolId)).size!==tools.length)issues.push('交付工具清单未完整对应已确认方案');
  for(const tool of tools){
    const selection=standard.tools.find(t=>t.toolId===tool.toolId);
    if(!selection||selection.form!==tool.form)issues.push(`${tool.toolId} 交付形式与方案不同`);
    if(tool.files.some(p=>!(p in files)))issues.push(`${tool.toolId} 交付文件不存在`);
    if(tool.form==='SCRIPT'&&(!(tool.entrypoint in files)||!tool.files.includes(tool.entrypoint)))issues.push(`${tool.toolId} 脚本入口不存在或未声明`);
    if(tool.form==='MCP'&&!delivery.services.some(s=>s.toolNames.includes(tool.entrypoint)))issues.push(`${tool.toolId} MCP 工具没有对应服务`);
  }
  const review=delivery.conformance;
  if(!review)issues.push('缺少独立候选审查');
  else {
    const ids=standard.requirements.map(r=>r.id);
    if(review.checks.length!==ids.length||new Set(review.checks.map(c=>c.requirementId)).size!==ids.length||review.checks.some(c=>!ids.includes(c.requirementId)))issues.push('独立审查未完整覆盖要求');
    const decoded=Object.fromEntries(Object.entries(files).map(([p,b])=>[p,Buffer.from(b,'base64').toString('utf8')]));
    for(const check of review.checks){
      if(check.status==='CONFORMING'&&!check.evidence.length)issues.push(`${check.requirementId} 审查缺少候选依据`);
      issues.push(...evidenceIssues(check.evidence,decoded));
    }
  }
  return issues;
}
export function conformancePassed(review:z.infer<typeof conformanceSchema>|undefined){
  return Boolean(review&&!review.issues.length&&review.checks.every(c=>c.status==='CONFORMING'));
}
