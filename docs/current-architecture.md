# 当前实现与代码定位

本文描述单 Skill / 多 Skill 统一迁移后的实际实现。历史方案见 `2.0/`；使用方式见 [迁移说明](multi-skill-migration.md)，部署从 [生产部署](production-deployment.md) 开始。

## 一条新任务流程

新任务有 1–10 个 Skill，成员数量不选择另一套编排。一个完整工作区包含成员、共享源码、资源和可选入口指令；每轮生成不可变候选，按任务验收，失败后修复工程再验收。单成员也使用工作区 Runtime v2 合同；需要升级 API 和内置 Runtime，旧 Runtime 不能仅凭支持 v1 就被视为兼容。

```text
web/src/features/migration/
  MigrationWorkspace            统一入口、旧任务桥接
  useMigrationWorkbench         表单、操作和版本选择
  useMigrationTask              列表、异步任务轮询
  *Stage / MigrationRunView     七阶段展示、实际证据
        ↓ /api/migration-tasks
src/interfaces/http/migration-task-routes.ts
        ↓
src/migration/tasks/
  composition.ts               唯一生产装配入口
  domain/task-model.ts         数据合同、候选摘要、成员校验、验收有效性
  application/task-service.ts   幂等、并发、取消、恢复、迁移/修复编排
  application/task-acceptance.ts 逐题运行、Judge、回收、冻结记录
  application/task-export.ts   验收绑定核对、环境复核、交付
  application/task-builder.ts  需求冻结、交付接收、版本绑定与历史
  infrastructure/task-builder.ts 复用准入登记、v2 生命周期及环境复核
  application/task-ports.ts    存储、源资产、Agent、Runtime、Judge、日志接口
  infrastructure/             文件存储、模型和 Runtime 适配器
        ↓
integrations/openjiuwen/
  bundle_agent.py              完整工程内分析/生成/修复
  bundle_runtime.py            1–10 成员装载与候选完整性核验
  worker.py / session.py       会话执行、模型、工具与结果
```

`application/domain` 不依赖 `service` 或具体 `infrastructure`。装配入口注入实现，架构测试约束方向并检查迁移模块的静态循环依赖。`src/migration/bundle/` 是旧导入路径兼容门面，不再维护第二套编排。Bundle 类型名、`bundle-*` ID、磁盘目录和 v1 存储版本保留，避免无必要的数据重写。

## 旧记录与旧能力

- 既有整组任务直接出现在统一列表，原 ID、候选、尝试、报告和摘要保留。
- 旧单 Skill v2 任务从「旧版任务记录」访问，原来的逐 Tool 决策、依赖配置、技术试运行、Runtime Builder、继续处理和导出仍由兼容实现承接。原 HTTP 接口保留，兼容客户端仍可调用。
- 新 UI 不再按单/多 Skill 分流，不通过旧流程创建新任务。
- 「转入统一迁移」复制明确选择的原始资产或候选资产，建立新任务并记录来源；原始记录不修改，不复制旧通过状态、运行配置或测试集。未生成候选时不能选择候选导入。
- 更早的 v0.1 记录维持只读和原始 JSON 导出，不自动升级结论。
- 新统一流程支持工程整体改造、Builder 需求导出 / 交付回填 / 版本绑定和真实任务验收。旧逐 Tool 技术验证保留在历史任务中。Builder 交付接收必须执行 v2 整组生命周期，不复用旧单成员验收作为通过依据。

## 运维或修改时从哪里查

| 现象/需求 | 先查 | 主要代码 |
| --- | --- | --- |
| 服务启动/停止失败 | supervisor、SCM/systemd、预检 | deploy/run.mjs、deploy/lib/settings.mjs、平台 manage 脚本 |
| API 鉴权、500、请求超时 | x-request-id、request_failed | src/service/server.ts、src/service/logging.ts |
| 任务忙、重复提交、取消和重启 | taskId、attemptId、operation 事件 | tasks/application/task-service.ts |
| 找不到源码、生成/修复失败 | agentRunId、agent_process_*、私有任务证据 | tasks/infrastructure/task-agent.ts、migration-agent-runner.ts、bundle_agent.py |
| 能力/模型/容量不兼容 | runtime-check、Runtime capabilities | tasks/infrastructure/task-runtime.ts、shared/contracts/runtime-bundle.ts |
| 验收执行失败 | runId + caseId、runtime_session_* | task-acceptance.ts、runtime-launcher.ts、worker.py、session.py |
| Judge 超时/格式/判定问题 | migration_judge_*、judgeRequestId、保护目录中的理由 | tasks/infrastructure/task-agent.ts、openai-compatible-model.ts |
| 下载拒绝/通过状态失效 | 当前候选、配置、测试集、环境摘要 | task-export.ts、domain/task-model.ts |
| 单阶段 UI 修改 | 对应 *Stage.tsx | web/src/features/migration/ |
| 历史任务兼容 | 原 schemaVersion 与旧任务接口 | migration-store.ts、migration/application、MigrationPanel.tsx |

## 配置责任

| 配置 | 读取位置 | 生效方式 |
| --- | --- | --- |
| API 地址、数据目录、访问令牌 | src/service/config.ts；部署预检在 deploy/lib/settings.mjs | 重启 API |
| 迁移 Python、模型别名、迭代/模型预算 | migration-agent-runner.ts、task-agent.ts、Python model_config.py | 更新服务环境后重启 API；新任务尝试生效 |
| Judge 地址、密钥、超时、出口代理 | config.ts、openai-compatible-model.ts | 更新服务环境后重启 API |
| Runtime 模型配置文件、进程配置 | integrations/openjiuwen | 重启 Runtime |
| 每任务模型、环境、执行超时、入口、工具权限 | 统一任务 Runtime 阶段 | 保存配置后重新验收 |

部署 dotenv 是数据，不能 shell source。模型凭据不放任务表单或日志。并发和存储是进程内协调：单个数据目录只允许一个 API 写入，当前不支持共享目录多副本。整组操作的进程并发上限为 2，API/Runtime 执行超时和停机清理时限各自独立。

## 修改后的验证入口

- `pnpm check`：Node、示例、Web 类型。
- `pnpm test`：领域、接口、兼容、架构、日志与 Runtime 合同回归。
- `pnpm test:ui:migration`：实际浏览器/API，确定性 Agent/Runtime/Judge 端口，验证失败→修复→重验与旧任务桥接；不作为真实模型效果证据。
- `MIGRATION_LIVE_MEMBERS=1` 或 `3` 配合 `pnpm test:ui:migration:live`：同一个 UI 测试入口验证单/多成员，使用真实 Agent、Runtime、Judge，报告明确记录 memberCount。私有环境变量和启动方式见生产部署文档。
- Python `test_bundle_runtime`：真实 ZIP 装载、成员清单、二进制资源、冻结候选校验，包括单成员 v2。

生产部署验收和这次工作树测试需分开记录；测试成功不会自动替换正在运行的 Windows/WSL 服务。

完整业务验收完成后，使用 `node scripts/verify-migration-log-correlation.mjs REPORT_DIRECTORY API_LOG` 检查实际请求、进程、Runtime 会话和 Judge 事件能否按持久化 ID 串联；审计输出只含 ID 和计数。`pnpm test:ui:migration:imports` 单独覆盖单文件、混合批量失败、整工程路径和窄屏导入。原 bundle 命名测试命令继续可用。旧版 v2 UI 回归通过历史 API 准备任务，然后从旧记录入口处理，不再依赖已移除的单 Skill 新建入口。

统一交付与旧任务导出共用 `domain/migration-export-safety.ts` 的凭据检查，保留旧流程对 `.env`、私钥及明显硬编码凭据的拒绝行为；不会为了通过导出而静默删除候选文件或改变冻结摘要。

Builder 产出的 Runtime 如何登记、旧任务的交付接口与新流程的支持范围，见 [Builder 接入](runtime-builder-integration.md)。
