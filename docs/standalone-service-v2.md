# Finance Skill Eval 独立服务 V2

## 产品入口

V2 采用与 EA 技能市场一致的 Skill-first 使用路径：

```text
灵感金融精选
  -> 选择岗位 Skill
  -> 固定当前 Skill 进入评测
  -> 配置左右版本与模型
  -> 自动预检共享 Runtime / MCP 环境
  -> 同题 A/B 执行
  -> 金融 Judge 与可复核报告
```

默认比较为“无当前 Skill vs 当前推荐版本”，左右共享题目、Agent Runtime 和工具环境。用户也可以比较同一 Skill 的不同版本或不同模型；当 Skill 和模型同时变化时，界面会提示结果不能单独归因于 Skill。

评测页默认选择在线执行。环境缺失或预检失败时显示具体问题，不自动退回冻结证据。历史回放必须由用户显式选择，且不能呈现为本轮现场运行。

## 运行架构

```text
Finance Skill Eval 控制面
├─ 精选 Skill 目录
├─ Analyzer / Eval Pack
├─ Promptfoo A/B 编排
├─ 任务队列、取消与重试
├─ 金融 Judge
└─ 报告与历史
          │ finance.skill-eval.runtime-request.v1
          ▼
Agent Runtime Integration
├─ OpenJiuwen Eval Runtime
├─ EA Runtime
└─ Generic HTTP Runtime
          │ 每轮按 requiredToolNames 注册
          ▼
MCP / Provider / 测试业务系统
```

独立服务不部署完整 EA。推荐部署一个轻量 OpenJiuwen Eval Runtime Worker，通过现有 Runtime HTTP 合同接入。V2 控制面允许登记多种 Runtime 类型，并为每个 Runtime 绑定一组 MCP；实际运行时只向 Runtime 下发当前所选任务需要的工具名称。

### 默认 Runtime 决策

默认演示环境采用独立的 OpenJiuwen Python Eval Runtime Worker：

- 它与 EA 当前 Python OpenJiuwen 内核接近，能够复用 Skill 和 MCP 的动态装配方式；
- 它不携带 EA 的岗位、工作区和治理提示，也不携带手机银行的意图路由与应用资产，适合作为隔离 Skill 变量的公共考场；
- Python 只属于该 Runtime Adapter 的实现选择，不进入 Finance Skill Eval 公共合同。

手机银行 OpenJiuwen Java Runtime 和 EA Runtime 作为可选真实环境接入，用于验证同一 Eval Pack 在不同 Runtime 上的表现。完整 WorkSwarm 不作为默认考场，因为其多 Agent、工作区和预装岗位能力会增加评测变量；需要验证复杂多 Agent Skill 时再显式选择。

## 精选 Skill 资产

`packs/finance/catalog.yaml` 是轻量、机器可读的精选目录。它只定义展示和岗位能力，不复制 Skill 或 Eval Pack 内容。服务根据 `targetSkillId` 关联已发布 Eval Pack，并计算：

- 可评版本；
- 任务数量；
- 工具需求；
- 可回放、需要在线环境或评测包待接入状态。

新增精选 Skill 不需要修改前端代码；添加目录项和对应 Eval Pack 即可。

## Runtime 与 MCP

测试环境区分两类资源：

1. Agent Runtime：OpenJiuwen、EA 或实现标准 HTTP 合同的其他 Runtime；
2. MCP 服务：提供 Skill 所需的工具能力。

Runtime 记录 MCP 绑定关系。评测开始前，服务检查 Runtime 健康状态，并对关联 MCP 执行 `initialize` 和 `tools/list`。运行请求同时携带：

```json
{
  "environment": {
    "environmentId": "env-openjiuwen",
    "requiredToolNames": ["get_governed_customer_profile"],
    "mcpServers": [
      {
        "serverId": "env-wealth-mcp",
        "transport": "streamable_http",
        "endpoint": "https://mcp.example/mcp",
        "toolNames": ["get_governed_customer_profile"]
      }
    ]
  }
}
```

工具真正执行仍由被测 Agent Runtime 负责；Eval 服务只做需求解析、环境预检、对照编排和证据收集。

## 输出与事件协议

AG-UI 和 Markdown 分属两层：

- AG-UI 可用于外部 Agent Runtime 的流式运行事件；当前本地 Worker 使用下述轻量 SSE 合同，并不宣称已实现 AG-UI 全协议；
- Markdown 用于候选答案和 Judge 评价的内容呈现。

评测服务内部保留稳定的 Job/Evidence 事件，不把 Core 绑定到 AG-UI。OpenJiuwen 或其他 Runtime 可以由北向 Adapter 消费 AG-UI 事件，再归一化为 `RuntimeExecutionEvidence`。Web 控制台使用与 EA 一致的 GFM Markdown 渲染规则展示标题、列表、表格、引用和代码块，且不执行模型返回的原始 HTML。

## Judge 模型

默认支持 OpenAI-compatible 模型接口。个人演示环境可选择 `codex_cli` Provider，通过当前主机的 Codex 登录运行 `gpt-6-astra` 匿名 Judge：

```text
FINANCE_EVAL_JUDGE_PROVIDER=codex_cli
FINANCE_EVAL_JUDGE_MODEL=gpt-6-astra
```

`pnpm serve:codex` 使用上述 Provider 启动服务。Codex Judge 默认模型为 `gpt-6-astra`，只接受 `FINANCE_EVAL_JUDGE_MODEL` 的显式模型覆盖，不继承做题侧通用的 `FINANCE_EVAL_MODEL`。已有报告保留原评阅模型，新一轮模型评阅使用当前配置。

Codex Judge 使用临时只读会话，提示中不传入左右版本身份。该方式消费登录账号的 Codex 配额，只作为本机演示适配器；共享部署改用服务账号或企业模型网关。模型级盲评并不是对可访问主机资源的安全隔离保证。

## 在线运行与候选改进

- 默认 Worker 固定 `openjiuwen==0.1.17.post1`，绑定回环地址 56362。控制台为 56361，独立只读业务快照 MCP 为 56363。
- Promptfoo 左右并发上限 2；每次执行生成独立子进程、会话及 MCP 客户端，结束、超时或连接取消后清理进程。服务不创建 EA 岗位实例。
- Runtime 请求只传题目、执行模型、目标 Skill 和工具需求；不发送评分量表、参考答案、回放证据或留出题。
- `SKILL.md` 进入目标侧系统上下文；包内文档通过受限 `read_file` 按需读取。基线没有目标包文件。默认 Worker 不执行上传包中的脚本、不提供主机文件或 Shell。
- SSE 返回 `status / text_delta / tool_start / tool_end`，最后返回完整 `RuntimeExecutionEvidence`。控制台定期合并内容，使用 react-markdown、remark-gfm、remend 渲染，不执行原始 HTML，不请求模型生成的远程图片。
- Recharts 展示四维均分、完成数、实际耗时及 Token。未评分不计零分，未知 Token 标记未提供。小样本胜出不等于统计显著或生产质量认证。
- `holdoutCaseFiles` 与普通 `caseFiles` 分开冻结，并纳入 Pack 指纹；不进入出题及优化提示。一次留出复测只提供有限的泛化证据，后续正式优化应补充真正未使用过的新留出集。

改进按钮触发一轮异步任务：

```text
已完成在线报告
  -> 独立 Optimizer 会话诊断专业缺口并提出文档修改
  -> 校验路径、Skill 身份、文档大小，生成不可变候选包
  -> 原版 A / 候选 B，同模型、同 MCP、同题，另加冻结留出题
  -> 独立 GPT-6 Judge 会话匿名复评
  -> 展示修改前后、逐题结论与质量图
  -> 人工保留候选或沿用原版
```

优化模型通过 `FINANCE_EVAL_OPTIMIZER_PROVIDER / MODEL` 独立配置，演示默认 Codex `gpt-6-astra`。不把模型故障、工具失败或未完成的 Judge 当作 Skill 缺陷；无冻结留出题的试卷不能发起自动候选复测。保留候选只记录本地选择，不自动发布至 EA 或修改原资产。

本地财富样例使用显式标注的模拟客户/产品/制度快照。模型回答和工具执行是现场真实发生的，但不是银行生产数据、Twenty 在线画像或实际交易验收。其他 Skill 需具备实际资产与匹配 MCP 才能标为在线支持。

安装、启动和验证步骤见 [本地在线演示](local-online-demo.md)。

## 边界

- Eval 服务是 Finance Harness Engineering Plane 的 Eval Lab，不进入生产 Agent 热路径；
- UI 可以复用 EA 的视觉和交互方式，但服务不依赖 EA 用户、岗位、工作区或临时 Agent；
- Runtime 是左右共享变量，不允许在一次 Skill 归因测试中分别选择两套工具环境；
- 用户上传的未知 Skill 可由 Analyzer 建议工具需求，但只有已登记和绑定的 Runtime/MCP 才能执行；
- 本版本提供 OpenJiuwen Runtime 接入类型和标准合同，不在 Node 控制面内重新实现 Agent Loop。
