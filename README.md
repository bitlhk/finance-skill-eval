# Finance Skill Eval

`finance-skill-eval` 是面向金融 Agent Skill 的可移植评测组件，用于回答一个直接的问题：

> 装配某个 Skill 后，Agent 在专业判断、业务完整性、表达质量和可执行性上，是否比无 Skill 或其他版本表现更好？

它将可复用的评测方法与具体 Agent 产品解耦，支持 AI 辅助准备测试题、同题左右对照、Promptfoo 执行编排、匿名专业 Judge、确定性回放以及 JSON/HTML 报告。

从 `0.3.0` 开始，同一内核提供三种使用形态：

```text
Library   EA 等产品内嵌使用
CLI       本地与 CI 批量运行
Service   独立控制台、上传 Skill、环境预检与历史报告
```

三种形态共用同一套 Eval Pack、Runner、Judge 和报告合同。独立服务是 Core 的可选托管外壳，不是第二套评测逻辑。

## 核心能力

迁移候选工作区的实现范围、私有启动及待验收项见 [Skill 迁移 V0.1](docs/skill-migration-v0.1.md)。当前不是已完成的跨 Runtime 迁移交付，公开站点不启用客户资产上传。

- **Skill 分析与出题**：分析 Skill 的目标、流程和依赖，辅助生成与其能力相匹配的测试任务。
- **同题 A/B 对照**：支持比较无 Skill 与有 Skill、不同 Skill 版本，以及相同 Skill 在不同模型上的表现。
- **Promptfoo 执行编排**：使用固定测试题和控制变量组织左右运行，记录输出、耗时、Token、工具调用与运行证据。
- **匿名专业评审**：Judge 不读取左右版本身份，只依据金融专业标准比较结果，降低位置和版本偏见。
- **金融 Eval Pack**：用版本化测试题、评分标准、专业 SOP 和校准证据表达财富管理、投资研究等领域要求。
- **结果可视化**：输出逐题对比、胜负结论、评分理由和改进建议，生成可保存的 JSON 与 HTML 报告。
- **平台无关接入**：通过 `RuntimeAdapter` 和 `ModelAdapter` 接入不同 Agent、模型、工具环境与运行时。
- **可选业务上下文增强**：宿主可通过 `EvaluationContextAdapter` 提供脱敏场景种子；未提供时仍可只分析 Skill 出题。
- **本地在线 Runtime**：独立 OpenJiuwen Python Worker，左右会话隔离，按需 MCP，实时 Markdown，结束和取消后回收。
- **候选改进闭环**：独立 GPT-6 Optimizer 生成文档候选，同条件复测及冻结留出验证，人工选择，不自动发布。

现场演示安装和使用说明：[本地在线评测](docs/local-online-demo.md)。默认财富样例使用明确标注的模拟业务快照，模型与工具现场执行，不是历史答案回放。

## 评测流程

```text
读取目标 Skill
        ↓
AI 分析能力并准备测试题
        ↓
冻结同一批测试题与运行条件
        ↓
左侧运行                右侧运行
无 Skill / 旧版本       目标 Skill / 新版本
        ↓                    ↓
        └──── 匿名专业 Judge ────┘
                         ↓
             逐题结论、专业评分与改进建议
                         ↓
                  JSON / HTML 报告
```

评测重点是证明 Skill 的业务增益，不以堆叠门禁或复杂治理为目标。宿主平台已有的授权、隐私、适当性和写操作确认仍由宿主运行时负责。

## 模型角色

每个 Eval Pack 可以独立配置三类模型：

1. **Analyzer**：读取 Skill，分析其解决的问题并准备测试题。
2. **Execution Left / Right**：在相同测试条件下分别完成左右两侧任务。
3. **Judge**：匿名比较两侧输出，给出金融专业评价和改进建议。

三类角色可以使用不同模型。例如，用高质量模型出题、被测业务模型完成任务，再由独立 Judge 模型评审。

可选第四类 **Optimizer** 专门生成 Skill 改进候选。它与 Judge 使用独立会话和配置；不接触冻结留出题，不以执行故障作为专业优化依据。本机默认 Judge/Optimizer 为 Codex `gpt-6-astra`，执行/出题为独立配置的 GLM-5.2。

模型密钥不写入 Eval Pack。Eval Pack 只保存 `credentialRef`，由接入平台在运行时解析。

## Eval Pack

Eval Pack 是一套可版本化的“金融试卷”，通常包含：

```text
eval.yaml                 评测目标、左右版本、模型和案例清单
cases/*.yaml              测试题、期望能力和专业断言
profiles/*-judge.yaml     Judge 评分维度与锚点
fixtures/evidence/*.json  脱敏回放证据或受控测试数据
```

Eval Pack 应同时表达：

- Skill 要解决的真实业务任务；
- 金融专业判断和业务 SOP；
- 哪些表现更有客户价值；
- 哪些信息缺失时应降级而不是编造；
- Judge 如何区分“格式更完整”和“专业判断更好”。

## 当前标准评测包

### 投资研究

`packs/finance/investment-research` 当前覆盖：

- 公司研究能否从资料罗列升级为可验证的研究闭环；
- 财务分析能否加入资产负债表交叉核验和可执行的后续动作。

### 财富管理

`packs/finance/wealth-management` 当前覆盖：

- 访前准备能否从客户资料罗列升级为聚焦决策变量的诊断；
- 条件充分时，能否先形成组合约束，再映射产品并解释方案取舍；
- 输出能否直接支持财富经理与客户沟通。

财富管理评测包使用已经冻结的 AI 专家匿名盲评校准证据。它可以证明专业输出差异，但不冒充独立人类专家签署，也不将回放证据表述为生产 Runtime 身份认证。

### 转账风险审核

`packs/finance/risk-review` 当前冻结三类任务：

- 命中已知涉诈风险时，能否引用账户和风险证据形成可复核意见；
- 未命中已知记录时，能否避免把结果解释为绝对安全或自动放行；
- 风险服务不可用时，能否保留可用事实并给出重试、人工审核或异常流程建议。

该评测比较无 Domain Skill 与装配 `transfer-risk-review` 的同模型输出。案例当前是在线运行输入，不附带伪造的回放答案；接入实际 Runtime 和受控 Provider Fixture 后再生成 A/B 证据。

连接同级目录下的 `finance-agent-harness`，运行受控 OpenJiuwen Candidate：

```bash
export FINANCE_AGENT_MODEL_API_KEY='<model-api-key>'
export FINANCE_AGENT_MODEL_BASE_URL='<openai-compatible-base-url>'
export FINANCE_AGENT_MODEL='glm-5.2'
pnpm eval:risk:harness
```

左右两侧使用相同模型、Capability Pack 和 Provider Fixture，唯一变量是是否装配风险审核 Domain Skill。运行结果写入 `reports/risk-review/live`。

2026-09-03 的真实 OpenJiuwen A/B 运行中，装配 Domain Skill 的一侧在三类任务中 `3/3` 获胜。控制变量、证据边界和报告指纹见 [验证记录](docs/verification/2026-09-03-risk-review-live-ab.md)。

## 快速开始

环境要求：Node.js 22 或更高版本、pnpm。

```bash
pnpm install
pnpm check
pnpm test
```

启动独立评测控制台：

```bash
pnpm build
pnpm serve
```

浏览器打开 `http://localhost:56361`。控制台默认可直接复核财富管理和投研的冻结证据；配置模型后可以上传 Skill、AI 出题并执行文本型 Skill 在线 A/B；工具型 Skill 通过外部 Agent Runtime HTTP 环境执行。

使用 Docker：

```bash
docker compose up --build
```

模型角色分别通过服务端环境变量配置，密钥不进入浏览器和 Eval Pack：

```text
FINANCE_EVAL_ANALYZER_BASE_URL / API_KEY / MODEL
FINANCE_EVAL_EXECUTION_BASE_URL / API_KEY / MODEL
FINANCE_EVAL_JUDGE_BASE_URL / API_KEY / MODEL
```

也可以使用统一的 `FINANCE_EVAL_MODEL_BASE_URL`、`FINANCE_EVAL_MODEL_API_KEY` 和 `FINANCE_EVAL_MODEL` 作为三类角色的默认配置。

在本机演示环境中，也可以让 Judge 使用当前主机已登录的 Codex 账号：

```text
FINANCE_EVAL_JUDGE_PROVIDER=codex_cli
FINANCE_EVAL_JUDGE_MODEL=gpt-6-astra
```

也可直接运行 `pnpm serve:codex`。Codex Judge 默认使用 `gpt-6-astra`，可通过 `FINANCE_EVAL_JUDGE_MODEL` 单独覆盖；它不继承通用的 `FINANCE_EVAL_MODEL`，出题和做题模型仍分别配置。

该模式通过 Codex CLI 的临时只读任务执行匿名评审，会消耗当前 ChatGPT/Codex 账号额度。它适合个人演示和校准，不建议作为多人共享服务的生产认证方式；共享部署应使用独立 API、服务账号或企业模型网关。

回放投资研究评测：

```bash
pnpm eval:investment:replay
```

报告输出到：

```text
reports/investment-research/report.json
reports/investment-research/report.html
```

回放财富管理评测：

```bash
pnpm eval:wealth:replay
```

报告输出到：

```text
reports/wealth-management/report.json
reports/wealth-management/report.html
```

## 接入其他 Agent 平台

评测 Core 不负责安装 Skill、管理用户权限或连接业务系统。嵌入式宿主或独立 Service 通过 Adapter 提供这些能力：

```ts
import {
  ModelPairwiseJudge,
  runEvaluation,
  type ModelAdapter,
  type RuntimeAdapter,
} from "finance-skill-eval";

const runtime: RuntimeAdapter = createYourRuntimeAdapter();
const judgeModel: ModelAdapter = createYourModelAdapter();

const report = await runEvaluation({
  pack,
  runtime,
  judge: new ModelPairwiseJudge(judgeModel, pack.models.judge),
});
```

### 组件负责

- Eval Pack 合同与加载；
- Promptfoo 左右运行编排；
- 匿名 Judge 与确定性回放；
- 结果聚合、评分和报告生成。

### 宿主平台负责

- Skill 安装、版本选择和运行身份；
- Agent Session、MCP 工具和业务数据；
- 模型凭据、岗位授权与数据权限；
- 原生 Trace 和用户界面。

### 独立 Service 负责

- 保存用户上传的 Skill 候选资产，但不代替 Skill 市场发布；
- 管理 Eval Run 队列、取消、单次重试、历史记录和报告导出；
- 对 MCP Streamable HTTP 服务做连接与工具发现预检；
- 通过标准 HTTP Runtime 合同调用 EA、OpenJiuwen Candidate 或其他 Agent；
- 提供独立控制台，不提供通用 Agent 对话页。

三类执行方式会在界面中明确区分：

```text
冻结证据回放       复核已有证据，不声称本轮重新调用 Agent
文本 Skill 直测     本轮真实调用模型，但不模拟工具
外部 Agent Runtime  本轮真实调用 Agent，由 Runtime 执行 Skill 和 MCP/业务工具
```

标准 Runtime HTTP 合同见 [独立服务与 Runtime 接入](docs/standalone-service-v1.md)。

## EA 集成方式

当前 EA 岗位智能体以嵌入式依赖方式使用本组件：

```text
EA 技能市场“评测”入口
        ↓
EA 评测接口
        ↓
finance-skill-eval
        ├── Promptfoo 执行编排
        ├── 金融专业 Judge
        └── 评测报告
        ↓
EA RuntimeAdapter
        ↓
隔离 Jiuwen Session + MCP + 原生运行证据
```

其他 Agent 平台可以实现自己的 Adapter，复用同一套金融评测方法与 Eval Pack，无需依赖 EA 的界面或运行时。

### 可选的业务场景适配

评测核心不依赖 CRM、数据库或某个 MCP。宿主可以选择实现
`EvaluationContextAdapter`，把自身业务系统中的可用场景转换为统一、脱敏的
`EvaluationContextSnapshot`：

```text
宿主客户 / 产品 / 知识工具
        ↓
EvaluationContextAdapter
        ↓
脱敏场景种子 + 不可变快照指纹
        ↓
Analyzer 生成更贴近当前环境的测试题
```

场景种子将可写入题面的 `promptFacts`、仅用于评审的
`verificationFacts` 和需要测试补齐能力的 `missingFacts` 分开。没有 Adapter
时，Analyzer 继续使用 Skill 源码和可选的固定 Eval Pack，不影响通用接入。

## 目录结构

```text
src/                         核心合同、Runner、Judge、Adapter 与报告
src/service/                 独立服务、资产与任务持久化
web/                         独立评测控制台
packs/finance/               金融领域标准 Eval Pack
tests/                       单元测试与回放验证
artifacts/                   本地构建包，不作为业务证据源
reports/                     本地生成报告，默认不提交真实敏感数据
```

## 证据与数据边界

- 不在仓库中保存模型密钥、生产凭据或真实客户敏感数据；
- 回放证据必须脱敏，并标明来源、时间和适用范围；
- AI 专家标签应明确标注为 AI 评审，不冒充独立人类专家 Ground Truth；
- 受控回放只能证明可复算的专业差异，生产运行身份需要宿主平台的原生 Trace 证明；
- 评测结论用于牵引 Skill 改进，不替代金融机构自身的合规审批与上线流程。

## 当前阶段

当前版本为 `0.4.0`，已完成：

- 可移植评测合同与 Runner；
- Promptfoo 左右对照；
- 模型匿名 Judge；
- 投资研究、财富管理与转账风险审核标准 Eval Pack；
- JSON/HTML 报告；
- EA 岗位智能体集成。
- 独立 Service 与可视化控制台；
- Skill ZIP 上传、AI/手工试题准备；
- Eval Run 排队、实时事件、取消、重试、历史与导出；
- MCP 环境预检和通用 Agent Runtime HTTP Adapter。
- “灵感金融精选”岗位 Skill 目录与 Skill-first 评测入口；
- 与 EA 一致的左右 Skill 版本/模型对比配置；
- OpenJiuwen、EA 和通用 HTTP Runtime 类型配置；
- Runtime 到 MCP 的绑定、联合预检和按任务工具清单下发。

本地 OpenJiuwen Worker、按题加载的模拟 MCP 和六类精选岗位在线 Eval Pack 已就绪；已发布到灵感平台的独立演示入口。公开模式只开放登录后的精选在线对比，完整上传与优化能力保留在本地工作区。不建设通用对话产品或复杂资产管理平台。

部署、覆盖范围、真实评测结果与回退说明见 [精选岗位演示发布记录](docs/curated-demo-release-2026-09-05.md)，总体设计见 [独立服务设计](docs/standalone-service-v2.md)。
