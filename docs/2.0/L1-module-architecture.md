# Finance Skill Eval 2.0：模块架构（L1）

## 1. 实现原则

- 围绕用户流程增量改造现有 `MigrationStore`，不先建立空的多层框架；
- 领域模型采用 2.0，新代码仍能读取 0.1 记录；
- Skill 检查与 Tool 检查分开；
- 决策、生成和验证都绑定具体 Tool 与具体资产；
- MCP 和 Script 的共同状态统一，执行方式分别实现；
- 本机 Worker 只负责一次任务，不拥有业务状态；
- 前端只消费后端计算的状态，不在浏览器中复制准入规则。

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

现有 `MigrationDiagnostics` 作为静态扫描基础，对外结果拆成 Skill 和 Tool 两个区域。

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
  recommendedAction: 'MIGRATE_TO_MCP' | 'MIGRATE_TO_SCRIPT';
};
```

这是迁移平台的检查结果，不是要求 Skill 工程提供的新文件。

### 3.4 ToolDecision

```ts
type ToolDecision = {
  toolId: string;
  action: 'MIGRATE_TO_MCP' | 'MIGRATE_TO_SCRIPT';
  targetLanguage?: string;
  reason: string; // 平台记录的选择说明，不要求用户填写
  baseAssetId: string;
  decidedAt: string;
};
```

`targetLanguage` 表示生成器选择，不参与 Tool 是否符合标准的判断。

## 4. 状态计算

```text
IMPORTED
  → INSPECTED
  → DECISIONS_REQUIRED
  → READY_TO_GENERATE / READY_TO_VALIDATE
  → TECHNICALLY_VALIDATED
  → OPENJIUWEN_VALIDATED
  → EVALUATED
  → OPTIMIZED
  → EXPORTABLE
```

重要规则：

- 存在未决 Tool 时不能生成或验证；
- 每个 Tool 都必须选择 MCP 或 Script；
- 缺少业务实现时仍可生成带待办的工程，但在补全实现前不能通过技术验证；
- 迁移动作必须有平台支持的生成器；
- 所有必需 Tool 的当前资产技术验证通过后，才能进入 OpenJiuwen；
- 候选摘要变化后，旧技术验证和 OpenJiuwen 验证不再有效。

## 5. SkillValidator

### 输入

- 当前 Skill 资产的文件清单和文本内容；
- `SKILL.md` 的路径和内容。

### 检查

- 单一 `SKILL.md`；
- `name`、`description` 和目录名规则；
- 引用文件存在；
- Tool 使用说明可识别；
- 密钥、绝对路径和 Runtime 专用业务步骤风险；
- 缺数、失败和拒绝处理说明。

### 输出

每个 finding 包含 `code`、`severity`、`path`、`line`、`message` 和 `suggestion`。检查器只读，不执行上传代码。

## 6. ToolInspector

### 发现顺序

1. 静态 MCP 声明和 Server 入口；
2. `SKILL.md` 明确引用；
3. Runtime SDK 的 Tool 注册；
4. 命令行入口、Python/Java 函数及测试；
5. 未能归属的业务函数只作为提示，不自动认定为 Tool。

### 证据原则

- 只有文件中可定位的内容才能成为静态证据；
- 注释和字符串中的 SDK 名称不算依赖；
- 函数名不能单独证明输入输出 Schema；
- Java、Python、JavaScript、Go 等 MCP 采用相同合规判断；
- `UNKNOWN` 不得提升为可移植；
- 已有 Tool 是否真正可运行由后续技术验证决定。

## 7. MigrationPlanner

`MigrationPlanner` 接收当前检查结果和逐 Tool 决策，输出：

```ts
type MigrationPlan = {
  baseAssetId: string;
  items: Array<{
    toolId: string;
    action: ToolDecision['action'];
    generator: 'SHARED_JAVA_MCP' | 'PYTHON_SCRIPT';
    blockingReasons: string[];
  }>;
  generationAllowed: boolean;
  technicalValidationAllowed: boolean;
};
```

一个计划可以同时包含共享 Java MCP 服务和 Python Script。所有选择 MCP 的 Tool 合并到一个服务工程中。

## 8. CandidateBuilder

- 每次生成建立新候选，不覆盖源资产；
- 只替换上一次由生成器拥有且未经人工修改的文件；
- 保留 Skill、references 和 assets；
- 为每个 Tool 分别记录生成文件和 Diff；
- 同一 Skill 的多个 MCP Tool 共用一个 MCP Server 工程和服务入口；
- 缺少业务实现或 Schema 时生成明确待办，验证状态为阻断；
- 生成后的 Skill 只在 Tool 名称或调用说明确有变化时修改。

首期生成器：

| 生成器 | 输出 |
| --- | --- |
| Java MCP | 单个共享 MCP Server 工程、多个 Tool 声明、业务端口骨架、测试和待办 |
| Python Script | `pyproject.toml`、`uv.lock`、命令入口、JSON 输入输出、测试和待办 |

生成器不得复制 Runtime SDK 的 Session、Context 或注册对象到业务接口。

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

## 10. TechnicalValidationService

### MCP

1. 构建或准备工程；
2. 启动 Server；
3. 完成 MCP 初始化；
4. 读取 Tool 列表并核对名称和 Schema；
5. 执行配置的正例与错误用例；
6. 停止服务并清理。

### Script

1. 准备锁定环境；
2. 使用生成器已知的入口执行；
3. 校验结构化输出和退出码；
4. 执行正例与错误用例；
5. 验证超时和取消；
6. 清理工作目录。

技术验证记录绑定 `assetDigest + toolId + implementationDigest + casesDigest`。

## 11. OpenJiuwenValidationService

现有 `integrations/openjiuwen/worker.py` 和 `session.py` 继续作为可信 Host。2.0 读取当前项目的 Skill 和 Tool 映射，不再依赖固定 PF Profile。MCP Tool 通过已登记的 MCP 环境装配；Script Tool 随当前 Skill 候选装入一次性会话目录，并由 Host 使用固定的 Python 或 Node 启动方式执行。

只有技术验证通过的 Tool 可以被装配。Host 返回当前 Skill 摘要、Tool 实现摘要、Runtime 和模型版本、每个测试用例的实际 Tool 调用，以及输出和断言结果。

## 12. HTTP API

```text
POST /api/migrations
GET  /api/migrations/:id
POST /api/migrations/:id/upgrade
POST /api/migrations/:id/inspect
GET  /api/migrations/:id/inspection
PUT  /api/migrations/:id/tools/:toolId/decision
GET  /api/migrations/:id/plan
POST /api/migrations/:id/generate
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

工作区使用七个可回看的阶段：

1. 导入工程；
2. 查看 Skill 和 Tool 检查；
3. 为每个 Tool 选择 MCP 或 Script；
4. 审阅候选及 Diff；
5. 查看技术验证与 OpenJiuwen 验证；
6. 评估和 Skill 优化；
7. 导出。

前端必须清楚区分：静态可移植、技术验证通过、OpenJiuwen 验证通过和历史 0.1 证据。

## 14. 测试架构

### 单元测试

- Skill 规则；
- Tool 发现和状态；
- 混合逐 Tool 决策；
- 计划准入；
- 摘要变化导致证据失效；
- 0.1 读取投影。

### 集成测试

- Runtime 绑定 Tool 分别生成 Java MCP 和 Python Script；
- 同一项目混合两种迁移方式；
- 同一 Skill 的多个 MCP Tool 只生成一个 MCP 服务；
- 缺业务实现项目被阻断；
- 本机 Worker 成功、失败、超时和清理；
- OpenJiuwen Host 装配当前 Tool 映射；
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
| `MigrationDiagnostics` | 保留静态扫描基础，输出拆为 Skill 和 Tool 检查 |
| `migration-candidate` | 改为按 Tool 生成并记录文件所有权 |
| `mcp-preflight` | 复用为 MCP 技术验证的一部分 |
| `CommandRuntimeAdapter` | 不作为隔离边界；只用于可信配置命令 |
| `MigrationTargetRuns` | 从固定 Profile 改为项目 Tool 映射驱动 |
| `OptimizationManager` | 复用，增加 Tool 文件不可修改约束 |
| 0.1 JSON 记录 | 继续读取并映射为历史视图，不改写原文件 |

## 16. 实施完成条件

实现必须覆盖 [features.md](./features.md) 的所有首期验收项，且现有非迁移评测能力保持通过。
