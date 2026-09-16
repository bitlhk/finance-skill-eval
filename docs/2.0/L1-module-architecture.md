# Finance Skill Eval 2.0：模块架构（L1）

## 1. 实现原则

- 围绕用户流程增量改造现有 `MigrationStore`，不先建立空的多层框架；
- **控制流固定，执行体放开**：stage 序列由人定，agent 不决定步骤；stage 内部可以是规则、单次模型或受限 agent；
- **授权归人，评判自动**：人工只出现在授权处，一切评判由确定性验证完成；
- **契约是证据产物**：每个 stage 的产出都绑定资产摘要，上游变化即失效；
- 领域模型采用 2.0，新代码仍能读取 0.1 记录；
- Skill 检查与 Tool 检查分开；
- 决策、生成和验证都绑定具体 Tool 与具体资产；
- MCP 和 Script 的共同状态统一，执行方式分别实现；
- 本机 Worker 只负责一次任务，不拥有业务状态；
- 前端只消费后端计算的状态，不在浏览器中复制准入规则。

### 1.1 阶段 A 的四个 stage

| Stage | 执行体 | 产出 |
| --- | --- | --- |
| A1 导入 | 规则 | `SkillAssetRecord` |
| A2 检查诊断 | **agent**（诊断）+ 规则（Tool 检查） | `Diagnosis` + `ProjectInspection` + 建议（形式 + 语言） |
| A3 授权 | **人工** | `ToolDecision[]` |
| A4 改造 + 验证 | 规则编排 + **agent**（生成） | 候选 `SkillAssetRecord` + 验证结果 |

阶段 B（评估）的设计见 [L0 §11.3](./L0-overall-architecture.md)，本文不展开。

## 2. 模块划分

```text
src/service/
├── migration-model.ts          # 2.0 类型、状态计算和逐 Tool 计划
├── skill-validator.ts          # 企业 Skill 规范静态检查
├── tool-inspector.ts           # Tool 发现与可移植性检查
├── portable-candidate.ts       # 2.0 不可变候选与 Diff
├── local-worker.ts             # 本机一次性任务执行
├── technical-validation.ts     # MCP / Script 技术验证编排
├── run-manager.ts              # OpenJiuwen 端到端验证与评估编排
├── migration-store.ts          # 项目聚合、持久化和兼容读取
└── server.ts                   # HTTP 接口
```

现有 `MigrationDiagnostics` 的扫描器保留，降级为 A2 agent 可调用的工具。

**Python 侧（agent 运行时）**：

```text
integrations/openjiuwen/
├── pyproject.toml      # 依赖声明（版本单一来源的一半）
├── uv.lock             # 传递依赖锁定（版本单一来源，见 §16）
├── session.py          # 既有：评估用 agent（ReActAgent）
├── worker.py           # 既有：本地监督进程，HTTP + SSE
├── analyze_agent.py    # 新增：A2 检查诊断 agent 入口
└── migrate_agent.py    # 新增：A4 改造 agent 入口

skills/enterprise-migration/   # 新增：A2 的判断依据（见 §6.7）
skills/enterprise-migration-delivery/  # 新增：A4 的交付形态依据（见 §6.7）
```

新增的两个 agent 入口是 `session.py` 的同类兄弟——同一套工具包装、事件上报、错误脱敏、进程隔离模式，差别只在系统提示词与工具集。三者**不复用同一个 session**：评估 agent 的"不执行写操作"等约束与 A4 需要的写工作区冲突。

## 3. 核心领域模型

### 3.1 MigrationProjectV2

```ts
type MigrationProjectV2 = {
  schemaVersion: 'finance.skill-migration.v2';
  id: string;
  name: string;
  createdAt: string;
  source: SkillAssetRecord;
  candidate: SkillAssetRecord | null;
  inspection: ProjectInspection | null;
  decisions: ToolDecision[];
  generations: ToolGeneration[];
  technicalValidations: TechnicalValidation[];
  openJiuwenValidations: OpenJiuwenValidation[];
  legacy?: LegacyMigrationView;
};
```

项目不保存可手工修改的总 `PASSED`。当前阶段和准入结果由资产、检查、决策及验证记录计算。

### 3.2 ProjectInspection

```ts
type ProjectInspection = {
  assetId: string;
  assetDigest: string;
  inspectedAt: string;
  skill: {
    status: 'COMPLIANT' | 'NON_COMPLIANT' | 'UNKNOWN';
    findings: SkillFinding[];
  };
  tools: ToolInspection[];
};
```

### 3.3 ToolInspection

```ts
type ToolInspection = {
  toolId: string;
  name: string;
  sourcePaths: string[];
  language: string | null;
  kind: 'MCP' | 'SCRIPT' | 'RUNTIME_BOUND' | 'UNKNOWN';
  portability: 'PORTABLE_MCP' | 'PORTABLE_SCRIPT' | 'RUNTIME_BOUND' |
    'INCOMPLETE' | 'UNSUPPORTED' | 'UNKNOWN';
  inputSchema: unknown | null;
  outputSchema: unknown | null;
  evidence: InspectionEvidence[];
  findings: ToolFinding[];
  // 平台建议，供 A3 人工授权参考；不代替人工决定
  recommendedForm: 'MCP' | 'SCRIPT';
  recommendedLanguage: string;
  recommendationReason: string;
};
```

这是迁移平台的检查结果，不是要求 Skill 工程提供的新文件。

### 3.4 ToolDecision

```ts
type ToolDecision = {
  toolId: string;
  form: 'MCP' | 'SCRIPT';       // 人工必选
  language?: string;            // 人工可选；缺省则采用 A2 的建议语言
  reason: string;               // 平台记录的选择说明，不要求用户填写
  baseAssetId: string;
  decidedAt: string;
};
```

这是**授权**产物：人工在这里批准"这个 Tool 的业务行为可以脱离原系统运行"。这是合规与风控判断，系统无依据可作。`language` 是可选的技术覆盖，不参与 Tool 是否符合标准的判断。

### 3.5 统一契约信封

所有 stage 产出共用同一外层信封，替换现存多个含义相同但命名不同的绑定字段（`assetDigest` / `artifactSha256` / `candidateDigest` / `baseAssetId` / `digest`）。

```ts
type StageEnvelope<T> = {
  schemaVersion: string;
  binding: {
    assetDigest: string;                  // 绑定的资产（唯一语义）
    stageId: 'A1' | 'A2' | 'A3' | 'A4';
    producer: 'RULES' | 'MODEL' | 'AGENT' | 'HUMAN';
    producedAt: string;
    inputDigests: Record<string, string>; // 依赖的上游产物
  };
  status: 'PRODUCED' | 'ABSTAINED' | 'FAILED';
  trace?: StageTrace;                     // 仅 agent stage
  payload: T;
};

type StageTrace = {
  rounds: Array<{
    artifactDigest: string;
    compileResult?: string;
    contractResult?: string;
    failureReason?: string;
  }>;
};
```

三条规则：

1. **绑定强制**——`binding.assetDigest` 说这个产物是照着哪份资产做的，`inputDigests` 说它吃了哪些上游产物；
   任一变化，本产物即失效。**`asset` 是保留键**：它就是 `binding.assetDigest`，不许在 `inputDigests` 里再起一个名字；
2. **弃权是一等状态**——`ABSTAINED` 是合法产出，agent stage 必须能返回它；
3. **人工门不可跳过**——`producer: 'HUMAN'` 的产物，任何 agent 产出都不能替代。

**这个信封管到哪里**（写清楚，免得有人到处找）：

| 是什么 | 归不归信封 |
| --- | --- |
| agent stage 的产出（A2 的分析、A4 的交付物） | ✅ 就落在这里 |
| 落盘的 `ProjectInspection` / 迁移记录 | 记录里存信封（`analysis`），但它自己的 `schemaVersion` 与字段是持久化格式，不跟着改 |
| `finance.skill-eval.runtime-request.v1` | ❌ **外部 Host 的契约**，不是我们的 stage 产物 |
| Skill 资产记录里的 `artifactSha256` | ❌ 0.1 就在的持久化字段，改了会破坏历史兼容 |

agent 进程自己在 stdout 上写的那行 JSON 是**传输封装**，不是 stage 产物；`runMigrationAgent` 把它映射成信封。

## 4. 状态计算

### 4.1 阶段 A（准入门槛）

```text
IMPORTED
  → INSPECTED              # A2 检查诊断完成
  → AUTHORIZED             # A3 逐 Tool 授权完成
  → GENERATING             # A4 生成循环进行中
  → ADMITTED               # 出口
```

准入出口 = **起得来、工具有、调得通** + Skill 合规可加载：

1. 合规自检；
2. 编译（按语言分支）；
3. 契约测试：MCP 能启动、`tools/list` 里有目标 Tool、`tools/call` 能返回；Script 入口能执行、输入输出能解析、退出码正确；
4. 加载检查（MCP `initialize`/`tools.list`，或 runtime `loadedSkills`）。

接口相对**基线**（A2 的分析结果）的差异**必须报告**并附改动理由，但**不是门禁**——迁移必然做适配，逐字一致做不到也不该要求。

重要规则：

- 存在未决 Tool 时不能生成；
- 每个 Tool 都必须选择形式（MCP / Script）；
- **不生成占位、待办或骨架实现**——agent 判定无法忠实迁移时返回 `ABSTAINED`，退回授权环节重新决策；
- 迁移形式必须有平台支持的生成器；
- 候选摘要变化后，阶段 A 的验证结果不再有效。

### 4.2 阶段 B（评估）

```text
ADMITTED
  → OPENJIUWEN_VALIDATED
  → EVALUATED
  → OPTIMIZED
  → EXPORTABLE
```

- 所有必需 Tool 的当前资产技术验证通过后，才能进入 OpenJiuwen；
- 候选摘要变化后，旧端到端验证不再有效。

## 5. SkillValidator

### 输入

- 当前 Skill 资产的文件清单和文本内容；
- `SKILL.md` 的路径和内容。

### 检查

- 单一 `SKILL.md`；
- `name`、`description` 和目录名规则；
- 迁移上传包内 `SKILL.md` 的准确大小写、标准子目录，以及脚本只能位于 `scripts/`；
- 引用文件存在；
- Tool 使用说明可识别；
- 密钥、绝对路径和 Runtime 专用业务步骤风险；
- 缺数、失败和拒绝处理说明。

### 输出

每个 finding 包含 `code`、`severity`、`path`、`line`、`message` 和 `suggestion`。检查器只读，不执行上传代码。

这些检查规则的依据来自**企业规范技能包** `enterprise-migration` 的 `SKILL.md` 第 ③ 节（见 §6.7），由 A2 agent 按需读取；规则本身可独立更新，不需改动提示词。

## 6. A2 检查诊断（agent）

A2 是一个 agent，不是一段规则代码。它承担两件事——企业 Skill 规范检查（§5 的规则）与 Tool 发现及可移植性判断——并产出**建议形式与建议语言**。

### 6.1 agent 配置

用 OpenJiuwen `harness` 的 `explore_agent`（只读探索型）：

```python
create_explore_agent(
    model            = <ANALYZER 角色>,
    system_prompt    = <迁移诊断专用提示词>,
    workspace        = 源工程解压目录,
    tools            = [read_file, grep, glob, list_dir, run_scanner],   # 自己装配
    rails            = [
        ToolCallResilienceRail(),
        TaskCompletionRail(...),                   # 完成信号 + 轮数/时长预算
    ],
    skills           = [企业规范技能包],
    max_iterations   = 15,
    enable_task_loop = True,                       # TaskCompletionRail 生效的前提
    search_via_bash  = False,                      # 用离散 GrepTool
)
```

**工具集**（全部自己装配，不用 `SysOperationRail`）：

| 工具 | 来源 |
| --- | --- |
| `ReadFileTool` / `GrepTool` / `GlobTool` / `ListDirTool` | 框架公开类，直接构造 |
| `run_scanner` | 本项目新增 |
| **`BashTool` / `PowerShellTool` / `WriteFileTool` / `EditFileTool` —— 一概不给** | —— |

**为什么不用 `SysOperationRail(read_only=True)`**：实测（版本见 §16 锁文件）它的只读分支是

```python
shared = [glob_tool, list_dir_tool, grep_tool, bash_tool]
if self._read_only:
    self.tools = [read_tool, *shared]
else:
    self.tools = [read_tool, write_tool, edit_tool, *shared]
```

只把 `write_file` / `edit_file` 摘掉，**`bash` 在两个分支里都注入**。bash 照样能写文件，所以那不是只读。要真正的只读只能自己装配工具集——**工具集就是白名单**。

### 6.2 输入与产出

- **输入**：源工程工作区（只读）+ 企业规范技能包
- **产出**：`Diagnosis` + `ProjectInspection`，含
  - **对 Skill 的分析**：用到了哪些工具、每个工具的输入输出、**样例**。它既是**基线**（迁移保留什么、校验比什么），也是**出题的种子**；
  - 逐 Tool 的 `recommendedForm` / `recommendedLanguage` / `recommendationReason`；
  写在**最终输出**里
- **基线与分析结果都要落到证据上**：主张只给 **原文片段**，平台按原文在文件里定位（`locate()`）——**行号由平台算，不由模型给**，
  也没有「没片段就用行号」这条退路。实测两轮：行号摆在它面前、描述也明说了行号是什么，8 条主张 8 条对不上，每次数字还不一样。
  所以**定位是前提不是保险**：原文找不到 = 这条主张不成立。唯一豁免是模型自己报的 findings 仍带行号（给人看的，
  且扫描器那边的行号是确定性的）
- **Skill 合规判定不由模型给**：模型报 findings（它擅长的是找问题），状态由平台的规则算（`validateSkill`，和判候选用的是同一套）。同一份包问两次模型，它给过 COMPLIANT 也给过 NON_COMPLIANT——**会翻的判定不是判定**。模型的发现并入 findings 列表供人看，但它不决定状态。
- **弃权**：最终输出中 `status = ABSTAINED`，附 `reason` 与 `missing`。
  **弃权要一路走到调用方**：它是 agent 的判断，不是故障。把 `ABSTAINED` 折成"没有分析"，
  调用方就只能报"分析不可用"——人看到一句无从下手的话，而 agent 明明说了缺什么

**不使用提交工具**。弃权是终态不是动作；且框架的工具包装会吞掉异常（`wrap()` 返回 `{"status":"unavailable"}`），工具无法提前终止循环。完成信号由 `TaskCompletionRail` 承载。

### 6.3 Tool 与契约从哪来

**靠分析，不靠"捞"。** 分析回答：用到了哪些工具、每个工具的输入输出、样例。

**不采用**：扫散文里的反引号当 Tool 名、正则从源码刨 `inputSchema` 字面量、让模型凭空填 Schema、从源码编样例输入。这四种都在找一个**源里未必存在**的东西——runtime 绑定的工具本来就没有"声明的 Schema"。

分析可以走的依据（作为线索，不作为结论）：MCP 自描述、`SKILL.md` 对工具用法的说明、Runtime SDK 注册、脚本与函数入口。任一条都要落到证据上。

### 6.4 证据原则

- 只有文件中可定位的内容才能成为静态证据；
- Analyzer 模型用于补查规则难以覆盖的间接 Runtime SDK 耦合，但路径、行号和原文片段必须由服务再次校验；
- 静态扫描器**不是必经前置，而是 agent 可调用的工具之一**。保留它是为了**覆盖率**——它按构造枚举全部文件并报告哪些读不了（二进制 / 超限），因而能回答 agent 回答不了的"我漏了什么"。这是"未完整覆盖 Tool 相关源码时必须人工确认"所依赖的依据；
- 注释和字符串中的 SDK 名称不算依赖；
- 函数名不能单独证明输入输出 Schema；
- Java、Python、JavaScript、Go 等 MCP 采用相同合规判断；
- `UNKNOWN` 不得提升为可移植；
- 已有 Tool 是否真正可运行由后续技术验证决定。

### 6.5 判据落点

agent 化之后，判据分成两处，边界必须守住：

| 落点 | 内容 | 为什么 |
| --- | --- | --- |
| **代码**（强制） | 分析产出的「文件 + 行号 + 逐字片段」校验、覆盖率计算、摘要绑定与失效、门禁判定 | 能机械验证；提示词是软约束，模型可以不遵守 |
| **技能包**（判断） | 六个可移植性状态的判定条件、形式与语言建议规则、授权与技术问题的边界 | 属于判断，且需要可独立更新而不动提示词 |

### 6.6 trace

按仓库已有模式采集，不引入新机制：

- `agent.stream()` 的事件流（[`integrations/openjiuwen/session.py`](../../integrations/openjiuwen/session.py) 的用法）
- 每个工具外套一层 wrapper，记录 `name` / `status` / `argumentsDigest` / `resultDigest`

两者共同填 `StageEnvelope.trace`。

### 6.7 技能包：按 workflow 分成两个

规范以**框架技能包**形式提供，agent 按需读取，不塞进系统提示。**一个包只描述一类任务**——A2 的"判断"和 A4 的"改造"是两条不同的 workflow，因此是两个包：

```
skills/
├── enterprise-migration/                # A2 检查判断用
│   └── SKILL.md                         # 判断规则全文（192 行，见下）
└── enterprise-migration-delivery/       # A4 改造交付用
    ├── SKILL.md
    └── references/
        └── service-templates.md         # 服务与脚本的骨架 + 硬要求
```

**为什么拆**（2026-09-17）：`service-templates.md` 原先放在判断包里，而那个包的 `description` 只声明了"检查与判断依据……判断是否合规、可移植性如何、建议迁移成什么形式和语言"——**逐字是 A2 的活，没有一个字提到"写出可运行的服务"**。于是 A2 每次都会把这份它用不上、且**设计上不该由它掌握**的材料读进去（见 [A4-migration.md](impl/A4-migration.md)"交付形态"与"不给平台的分类判断"两侧的边界）。

实测代价：`service-templates.md` **364 行 / 14.5 KB，比 A2 那五篇加起来（183 行 / 10 KB）还大**；A2 一次跑的 11 个回合里 7 个是取技能材料，其中就有它。

**为什么把 A2 那五篇并成一篇**：references 的意义是"**按需**只加载需要的那份"，可 A2 的活就是"读这个包、给出判断"——**五篇它每次都要**，按需加载收益为零，只剩五次往返。并成一篇后取材料从 7 次降到 2 次（索引 + 正文），读的字节数不变。

**合并同时消掉一处矛盾**：`evidence-rules` 写"`line` 必须是真实行号"，`analysis-rules` 写"不要给行号、由平台按原文定位"——分在两处读起来自相矛盾。真相是**两条路各管各的**：finding 带行号且平台会核对，分析主张只给片段、行号由平台算。并进一篇才能把这条并列讲清楚（见 `enterprise-migration/SKILL.md` 第 ① 节）。

**判据按 workflow 分组，不按"文件数"分组**：agent 需要的是它那一类任务的完整规则，而不是能被选择性加载的碎片。

**语言判据已定**：同语言优先 → 生态最接近 → 兜底（MCP 用 Java、Script 用 Python）；源语言不在支持范围则 `UNSUPPORTED`。实现在 `migration-model.ts` 的 `recommendLanguage()`，原则写进 `enterprise-migration/SKILL.md` 第 ⑤ 节，**目标语言集合不写进技能包**——那是平台能力，会随模板增减而变。

### 6.8 已核对的框架 API

以下已在锁定的运行时版本上**实测核对**（见 §16），不是照文档推测：

| 用途 | 名称 | 导入路径 |
| --- | --- | --- |
| A2 agent | `create_explore_agent` / `build_explore_agent_config` | `openjiuwen.harness.subagents.explore_agent` |
| A4 agent | `create_code_agent` / `build_code_agent_config` | `openjiuwen.harness.subagents.code_agent` |
| 完成信号 | `TaskCompletionRail` | `openjiuwen.harness.rails` |
| 预算评估器 | `MaxRoundsEvaluator` / `TimeoutEvaluator` / `TokenBudgetEvaluator` / `CompletionPromiseEvaluator` | `openjiuwen.harness.schema.stop_condition` |
| 工具调用韧性 | `ToolCallResilienceRail` | `openjiuwen.harness.rails.tool_call_resilience_rail`（**未从 `harness.rails` 再导出，必须走全路径**） |
| 文件工具 | `ReadFileTool` / `WriteFileTool` / `EditFileTool` / `GlobTool` / `GrepTool` / `ListDirTool` | `openjiuwen.harness.tools` |
| 系统操作层 | `SysOperation` / `OperationMode` | `openjiuwen.core.sys_operation` |

**核对时推翻了初稿的三处**：

1. `LLMRetryRail` **不存在**——该职责现由 `ToolCallResilienceRail` 与 `ModelAnomalyDetectionRail` 承担；
2. `SysOperationRail(read_only=True)` **不是只读**——bash 在只读分支里照旧注入；
3. `SysOperationRail` **无法去掉 shell**——`BashTool` 无条件注册，`bash_deny_patterns` 只是拒绝名单。

第 2、3 条直接改变了 A2/A4 的工具装配方式（见 §6.1、§8.0）。**harness 是活跃模块，小版本之间会增删——版本冻结后必须实测核对，不能照抄旧版本。**

## 7. MigrationPlanner

**这是派生视图，不是独立 stage。** 它是（检查结果 + 逐 Tool 授权）的纯函数——输入全为确定性数据，无一处需要判断，因此按需算出来即可，不必冻结为独立产物。

```ts
type MigrationPlan = {
  baseAssetId: string;
  skillMigrationItems: string[];
  skillBlockingReasons: string[];
  items: Array<{
    toolId: string;
    form: ToolDecision['form'];
    language: string;                 // 授权给定的语言，或 A2 的建议
    blockingReasons: string[];
  }>;
  generationAllowed: boolean;
};
```

一个计划可以同时包含共享 MCP 服务和 Script（Python / Node）。选择 MCP 的 Tool **按实现语言分组**，每种语言一个服务工程（`mcp-java/` / `mcp-python/` / `mcp-node/`）。

Skill 规范检查的错误写入 `skillMigrationItems`，不作为源包生成门禁。`skillBlockingReasons` 只保留给无法安全生成的系统级冲突；当前目录和文件冲突采用稳定重命名处理，因此不阻塞。候选包必须重新通过 Skill 规范检查后才能被采纳。

## 8. A4：改造 + 验证（循环）

A4 不是一个生成动作，而是一个**循环**：

```
   生成 ──→ 合规自检 ──→ 编译 ──→ 契约测试 ──→ 加载检查
    ↑                                            │
    └────────── 失败原因回灌 ─────────────────────┘

### 拿到什么

只传三样：**人的决定（形式、语言）+ 基线（工具、输入输出、样例）+ 源码**。

**不传平台的分类判断**（`portability`、`kind`、findings、evidence）。那些是给授权环节的人做决定的；喂给 agent 只会让它照着标签走，而不是自己去读代码。

### 交回什么

| 交什么 | 为什么 |
| --- | --- |
| 代码，**含服务外壳与适配器** | **平台不生成服务、不往工作区播种**；模板只作为技能包 `references/` 里的**指导** |
| **启动命令** | 代码是 agent 写的，怎么起它最清楚；平台据此起服务做校验 |
| 接口改动理由 | 基线差异要能解释——哪处是适配必须的 |
| README | 给人看怎么跑 |

### 运行环境

在 **Skill 包自己声明的环境**里跑，不是 agent 的环境（见 [L0 §2](./L0-overall-architecture.md) 环境隔离）。
```

**回灌内容**：上一轮产物 + **哪一层失败、失败原因**。没有这个就只是重试，不是"有错就改"。

### 8.0 agent 配置

用 OpenJiuwen `harness` 的 `code_agent`：

```python
create_code_agent(
    model            = <MIGRATION 角色>,
    system_prompt    = <实现迁移专用提示词>,
    workspace        = 本轮候选工作区,             # 每轮干净副本
    tools            = [read_file, write_file, edit_file, grep, glob, list_dir,
                        compile_tool, run_contract_test],   # 自己装配，不含 shell
    rails            = [
        ToolCallResilienceRail(),
        TaskCompletionRail(...),
    ],
    skills           = [企业规范技能包],           # 与 A2 共用
    max_iterations   = 25,
    enable_task_loop = True,
)
```

**工具集**（全部自己装配）：

| 工具 | 来源 |
| --- | --- |
| `ReadFileTool` / `WriteFileTool` / `EditFileTool` / `GrepTool` / `GlobTool` / `ListDirTool` | 框架公开类，直接构造 |
| `compile_tool` / `run_contract_test` | 本项目新增 |
| **`BashTool` / `PowerShellTool` / `CodeTool` —— 一概不给** | —— |

**不给通用 shell。** A4 需要的是编译和验证，走两个专用工具；让 agent 自己拼命令既没必要，也让 trace 不可读。

**这一点必须自己装配工具才能做到**：`SysOperationRail` **无条件**注册 `BashTool`（Windows 上还有 `PowerShellTool`），没有参数能去掉；`bash_deny_patterns` 只是拒绝名单，不是允许名单。所以不能靠参数，只能不用那个 rail。

`CodeTool` 即使 `with_code_tool=True` 也不该用——它是**执行任意代码**（`execute_code(code, language, timeout)`），不是编译。用自己的 `compile_tool`：窄、可控、trace 里能清楚记"编译失败了"。

**弃权**：与 A2 同机制，写在最终输出里，且是**逐 Tool** 的——一个 Tool 弃权不拖累其他 Tool。

### 8.0.1 两级预算

| 层级 | 载体 |
| --- | --- |
| 单轮 agent 步数 | `max_iterations` |
| 循环轮数 / 总时长 | 框架的 `MaxRoundsEvaluator` / `TimeoutEvaluator` |

两者都显式，不混用。

**出口**：

| 出口 | 条件 | status |
| --- | --- | --- |
| 通过 | 四层全过 | `PRODUCED` |
| 弃权 | agent 判定某个 Tool 无法忠实迁移 | `ABSTAINED`，退回 A3 |
| 耗尽 | 轮数或时长预算用完 | `FAILED` |

轮数上限与总时长上限都必须显式，否则循环没有终止保证。

### 生成约束

- 每次生成建立新候选，不覆盖源资产；
- 只替换上一次由生成器拥有且未经人工修改的文件；
- 保留 Skill、references 和 assets；
- 为每个 Tool 分别记录生成文件和 Diff；
- 同一 Skill 中**同语言**的多个 MCP Tool 共用一个 MCP Server 工程和服务入口；
- **不生成占位、待办或骨架实现**——无法忠实迁移时返回 `ABSTAINED`，不交付业务骨架；
- 生成后的 Skill 只在 Tool 名称或调用说明确有变化时修改。

### 生成器

| 生成器 | 输出语言 | 产物 |
| --- | --- | --- |
| MCP | **按源 Tool 判断**：同语言，或便于转换的语言 | 单个共享 MCP Server 工程、多个 Tool 声明、迁移后的完整业务实现、构建与部署文件 |
| Script | **Python / Node** | 迁移后的完整入口和辅助源码、固定依赖、JSON 输入输出及可执行检查 |

生成器不得复制 Runtime SDK 的 Session、Context 或注册对象到业务接口。

### 判据

契约测试的**门禁只有三条：起得来、工具有、调得通**。接口相对**基线**的差异是**报告**，不是门禁——迁移必然做适配，逐字一致做不到也不该要求。

基线和样例都来自 **A2 对 Skill 的分析**（用了哪些工具、输入输出、样例），不是从源码刨的，也不是模型即席填的。**不允许用模型自写的测试输入当门禁判据**（出题人、答题人、判卷人会是同一个）。

### 测试集：从分析生成，不手写

迁移的测试集**由分析生成**，复用平台已有的出题能力（`ANALYZER` 角色 + `analyzeSkillAndGenerateCases`）。分析提供**grounding**，模型写题：

| 出题用到的 | 来自哪 |
| --- | --- |
| Skill 该怎么用（instructions 与 references） | **源资产**——作者写的意图 |
| 能出什么题（`allowedTools`） | 分析读出来的工具清单 |
| 题面里能出现什么对象与形状 | 分析的输入输出 Schema 与**样例** |
| 题面本身 | 出题模型 |

三条边界：

1. **对着源资产出题，不对着候选出题**。拿刚生成的东西出题，等于让它自己给自己判卷；
2. **Skill 原文取源资产**，取候选会拿到平台改写过的措辞，那是平台的表述不是作者的要求；
3. **手写题集这条路留着**（`createSuite`），但默认路径是生成——手写等于让人再发明一遍工具面，正是分析要消掉的那件事。

界面上在"验证能否运行"那步：生成测试集、展开看题目，然后在整 Skill 验证的**测试内容**里把迁移测试集和现有题集并列选。
选中的是测试集时，运行配置里走 `preparationId`（store 会校验它属于本次迁移），选现有题集时走 `packId`——两者二选一，不混。

验收措辞只能是「**接口未见显著变化，且在生成的测试集上通过**」。runtime 绑定的源跑不起来，写"效果一致"没有强证据。

## 9. LocalWorker

```ts
type LocalWorkerRequest = {
  requestId: string;
  assetDigest: string;
  toolId: string;
  program: string;
  args: string[];
  files: Array<{ path: string; content: Uint8Array }>;
  timeoutMs: number;
  maxOutputBytes: number;
};

type LocalWorkerResult = {
  requestId: string;
  mode: 'LOCAL_TRUSTED';
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
};
```

实现要求：

- `program` 必须来自服务端允许列表，不能来自模型输出；
- 参数由验证器生成，不拼接 Shell 字符串；
- 工作目录是新建临时目录；
- 限制运行时间和输出大小；
- 完成、失败或取消后清理目录；
- Windows 首期使用可直接启动的程序，不依赖 Bash；
- 返回结果明确标记 `LOCAL_TRUSTED`。

### 9.1 面向 agent 的扩展

A4 的生成 agent 需要在一个工作区内多次调用程序（读、写、编译、跑测试）。因此 LocalWorker 需要支持**同一工作目录跨多次调用保活**，而不只是现在的一次性 `run`。

安全属性全部保留：允许列表、临时目录、路径约束、超时、输出上限、结束清理。

## 10. TechnicalValidationService

### MCP

1. 构建或准备工程；
2. 启动 Server；
3. 完成 MCP 初始化；
4. 读取 Tool 列表并核对名称和 Schema；
5. 执行配置的正例与错误用例；
6. 停止服务并清理。

**怎么起，由交付物说了算。** `start`（argv 数组）是起服务的命令，`prepare`（可选）是它前面那次性的一次
（装依赖、构建）；平台只做三件事：挑一个空闲端口、把端口放进 `PORT` 环境变量、等服务监听。这和 Script 那条
路是同一条道理——入口是 agent 报的，平台不猜。

只有**本来就以 MCP 提供、不是本次迁移出来的 Tool** 才由操作者填 endpoint：它没有交付物，平台没有可执行的
启动命令。拿手工 endpoint 代替启动命令，等于**从没验证过交付的服务自己起不起得来**——只有 agent 说它起得来。

### Script

1. 准备锁定环境；
2. 使用生成器已知的入口执行；
3. 校验结构化输出和退出码；
4. 执行正例与错误用例；
5. 验证超时和取消；
6. 清理工作目录。

### 契约测试（阶段 A 准入层）

契约测试是 A4 循环的判据层，与上面的技术验证分开：

- 门禁（硬）：MCP 能启动、`tools/list` 里有目标 Tool、`tools/call` 能返回；Script 入口能执行、输入输出能解析、退出码正确；
- 报告（软）：迁移后的输入输出相对**基线**（A2 的分析结果）的差异，附 agent 给出的**每处改动理由**；
- 差异越小越好，但**有理由的适配改动是正常的**——逐字卡一致性等于拿基线当法律；
- 只判接口，不判业务值——业务值正确性属于阶段 B。

技术验证记录绑定 `assetDigest + toolId + implementationDigest + casesDigest`。

## 11. OpenJiuwenValidationService（阶段 B）

这一层判定的是 **Skill 与 Tool 合起来能否完成任务**，属于能力评价，因此不计入阶段 A 的准入门槛。

现有 `integrations/openjiuwen/worker.py` 和 `session.py` 继续作为可信 Host。2.0 读取当前项目的 Skill 和 Tool 映射，不再依赖固定 PF Profile。MCP Tool 通过已登记的 MCP 环境装配；Script Tool 随当前 Skill 候选装入一次性会话目录，并由 Host 使用固定的 Python 或 Node 启动方式执行。

**关键：这一层是唯一真正执行迁移产物的地方。** `session.py` 会实际启动 Script Tool（`uv run … python <entry>` / `node <entry>`）并调用 MCP Tool（fastmcp `Client` + `call_tool`）。换成 Python runtime 之后，迁移出来的 Tool 第一次进入执行——这正是原先"验证链没有验证被迁移的东西"的解。

**两种形式都必须能装配：**

| 形式 | 装配方式 |
| --- | --- |
| Script（Python / Node） | 随候选的 `files` 落入一次性会话目录，按入口执行 |
| MCP | 通过已登记的 MCP 环境端点装配并 `call_tool` |

**当前实现的缺口**：`validateOpenJiuwen` 构造 `runtimeToolBindings` 时只筛 `kind === 'SCRIPT'`，**MCP Tool 不进入绑定**——也就是说 MCP 候选走完阶段 A 之后没有任何端到端验证。这一条要补上。

只有技术验证通过的 Tool 可以被装配。Host 返回当前 Skill 摘要、Tool 实现摘要、Runtime 和模型版本、每个测试用例的实际 Tool 调用，以及输出和断言结果。

## 12. HTTP API

```text
POST /api/migrations
GET  /api/migrations/:id
POST /api/migrations/:id/upgrade
POST /api/migrations/:id/inspect
GET  /api/migrations/:id/inspection
PUT  /api/migrations/:id/tools/:toolId/decision   # 授权：form 必选 + language 可选
GET  /api/migrations/:id/plan                     # 派生视图，非独立产物
POST /api/migrations/:id/generate                 # A4 循环
GET  /api/migrations/:id/candidate
POST /api/migrations/:id/validate/technical
GET  /api/migrations/:id/validations/technical
POST /api/migrations/:id/validate/openjiuwen
GET  /api/migrations/:id/validations/openjiuwen
POST /api/migrations/:id/evaluations
POST /api/migrations/:id/optimize
GET  /api/migrations/:id/report
GET  /api/migrations/:id/export
```

写接口携带当前 `baseAssetId`。资产已变化时返回冲突，要求用户刷新。0.1 接口在兼容期继续读取旧记录；新前端只使用 2.0 接口。

## 13. 前端模块

工作区分两个阶段、可回看：

**阶段 A（准入门槛）**

1. 导入工程；
2. 查看 Skill 和 Tool 检查诊断（含平台的建议形式与建议语言）；
3. 授权：为每个 Tool 定形式（必选）与语言（可选）；
4. 改造 + 验证：审阅候选、Diff 与循环轨迹。

**阶段 B（评估）**

5. 端到端验证；
6. 评估和 Skill 优化；
7. 导出。

前端必须清楚区分：静态可移植、契约测试通过、技术验证通过、端到端验证通过和历史 0.1 证据——**尤其是契约测试通过不等于业务正确**。

## 14. 测试架构

### 单元测试

- Skill 规则；
- Tool 发现和状态；
- 混合逐 Tool 授权；
- 语言采用授权值或建议值；
- 计划派生（纯函数）；
- 摘要变化导致证据失效；
- **契约测试**：门禁三条（起得来 / 工具有 / 调得通）；接口相对基线的差异被报告并附改动理由；
- 0.1 读取投影。

### 集成测试

- Runtime 绑定 Tool 分别生成 MCP（按源语言）和 Script（Python / Node）；
- 同一项目混合两种迁移方式；
- 同一 Skill 中同语言的多个 MCP Tool 只生成一个 MCP 服务；
- **A2 agent**：只读 rail 生效（写工具不可调用）；`run_scanner` 的覆盖率进入产出；判定不足时返回弃权；工具调用与摘要进入 trace；
- **A4 agent**：通用 shell 不可用；`compile_tool` 与 `run_contract_test` 两层失败可区分；
- **A4 循环**：编译失败回灌后重生成；契约测试失败回灌后重生成；预算耗尽返回 `FAILED`；
- **弃权**：agent 判定无法忠实迁移时返回 `ABSTAINED` 并退回授权，不交付骨架实现；
- **门禁不可自证**：模型无法影响契约测试的判据；
- 本机 Worker 成功、失败、超时和清理；
- **同一工作目录跨多次调用保活**（agent 扩展）；
- OpenJiuwen Host 装配当前 Tool 映射（阶段 B）；
- 评估完成后 Optimizer 只改变 Skill。

### 安全回归

- 扫描阶段不执行上传代码；
- Worker 不能运行允许列表之外的程序；
- 路径不能逃逸临时工作目录；
- 凭据文件不能进入导出包；
- 旧验证不能用于已变化的候选。

## 15. 与现有模块的关系

| 现有模块 | 2.0 处置 |
| --- | --- |
| `MigrationStore` | 增加 2.0 聚合与旧记录投影，逐步收窄旧写接口 |
| `MigrationDiagnostics` | 静态扫描保留并降级为 agent 的工具；模型调用由单次改为 agent 循环 |
| `migration-candidate` | 改为按 Tool 生成并记录文件所有权 |
| `mcp-preflight` | 复用为 MCP 技术验证的一部分 |
| `CommandRuntimeAdapter` | 不作为隔离边界；只用于可信配置命令 |
| `MigrationTargetRuns` / `verifyTarget` | **摘掉产品地位**。原先绑 Java 参考 Host 且只服务 legacy；最终验证统一到 `validateOpenJiuwen`（Python）后，这条链不再承担验证职责。代码去留另定 |
| `OptimizationManager` | 复用，增加 Tool 文件不可修改约束 |
| 0.1 JSON 记录 | 继续读取并映射为历史视图，不改写原文件 |

## 16. 版本与依赖策略

**单一来源：`integrations/openjiuwen/uv.lock`。** 运行时版本与传递依赖都锁在这里，**文档、提示词、代码都不硬编码版本号**——版本会升级，写死在文档里必然过期。

规则：

- **不在文档里写版本号**。需要版本时从锁文件或 `importlib.metadata` 读；
- 运行时依赖用 `uv.lock` 锁定，**取代了原先的 `requirements.txt`**（它只 pin 了 7 个直接依赖，传递依赖——fastapi / fastmcp / opentelemetry 及其依赖树——全在漂）；
- **`scripts/start-openjiuwen.cmd` 从 lock 安装**：`uv sync --locked --project integrations/openjiuwen`；
- **`UV_PROJECT_ENVIRONMENT` 可外部覆盖**，默认指向 `.venv-openjiuwen`。env 用 `python -m venv` 建，再由 uv 同步进去（已实测：uv 接受这种环境）；
- **uv 必须在 PATH**——环境安装和静态扫描器（`scripts/scan-migration.py`）都依赖它。launcher 会检查并在缺失时给出提示；
- Python 需 3.11–3.13，由 openjiuwen 自己声明（`requires-python <3.14,>=3.11`）。**3.14 不可用**——若只找到 3.14，安装会失败，这是预期行为，不是配置错误；
- **注意 uv 的解释器发现**：`uv python list` 只枚举基础环境与 uv 自管安装，**不列出 conda env**；但显式指定即可使用（`uv lock --python <envs/py312/python.exe>`）。本仓库的锁与运行时环境就是用 conda env 解释器生成的；
- 证据里上报的版本必须**动态读取**。`session.py` 现在写死了字面量，应改为 `importlib.metadata.version("openjiuwen")`；否则升级后证据会撒谎；
- **Java 参考 Host 冻结，不参与版本策略**——它是测试夹具，不是运行时。

改锁的正确姿势：

```bash
uv lock --project integrations/openjiuwen
```

`--locked` 会在 pyproject 与锁不一致时报错，所以改过依赖必须重新锁一次，不能只改 `pyproject.toml`。

## 17. 实施完成条件

实现必须覆盖 [features.md](./features.md) 的所有首期验收项，且现有非迁移评测能力保持通过。
