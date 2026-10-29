# 当前实现与代码定位

本文描述单 Skill / 多 Skill 统一迁移后的实际实现。历史方案见 `2.0/`；使用方式见 [迁移说明](multi-skill-migration.md)，部署从 [生产部署](production-deployment.md) 开始。

## 一条新任务流程

新任务有 1–10 个 Skill，成员数量不选择另一套编排。Runtime 通过 `finance.runtime-instance.v1` 接收 skills[] 和可选 assets，Agent 工作区只装载这些已选择的说明、依赖与入口指令，不要求完整工程 ZIP；每轮生成不可变候选，按任务验收，失败后修复工程再验收。单成员使用同一实例合同；Eval、Builder 与 Runtime 需按[标准协议](runtime-contract-boundary.md)同步升级，不能仅凭旧版本号判定兼容。

验收区分业务未通过与基础设施未完成：Runtime 或 Judge 异常记录为 `INCOMPLETE`，保存已取得的执行证据及 `failureStage`。
Judge 格式不完整时最多重试一次，保持已经明确返回的判定；完整的业务不通过不重试。
评审服务异常不能作为改写候选的依据，UI 和服务端都会阻止将该记录交给修复 Agent。
Agent 的分析或交付说明格式不符时，复用无工具的 `model-output-correction.ts` 最多纠错一次；
已有合同字段必须保持相同，实际文件不进入纠错通道，也不重新运行代码 Agent。

```text
web/src/features/migration/
  MigrationWorkspace            统一任务入口
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
  infrastructure/task-builder.ts 标准 Runtime 准入、生命周期及环境复核
  application/task-ports.ts    存储、源资产、Agent、Runtime、Judge、日志接口
  infrastructure/             文件存储、模型和 Runtime 适配器
        ↓
integrations/openjiuwen/
  bundle_agent.py              所选 Skill 及依赖的分析/生成/修复
  skill_set.py                 skills[]、可选资源、摘要与路径核验
  bundle_runtime.py            冻结文件完整性及旧归档辅助函数
  worker.py / session.py       会话执行、模型、工具与结果
```

`application/domain` 不依赖 `service` 或具体 `infrastructure`。装配入口注入实现，架构测试约束方向并检查迁移模块的静态循环依赖。`src/migration/bundle/` 是旧导入路径兼容门面，不再维护第二套编排。Bundle 类型名、`bundle-*` ID、磁盘目录和 v1 存储版本保留，避免无必要的数据重写。

## 升级与历史数据

- 新服务只接受 `/api/migration-tasks` 和当前标准合同，不提供旧记录 UI、旧 API 别名或「转入统一迁移」。`/api/migrations`、`/api/migration-bundles` 和旧转换接口返回 404。
- 历史文件不自动删除，但文件保留不等于旧任务还能访问、继续处理或导出。文件仓库只加载当前任务存储协议；存储版本及 ID 未变化也不代表旧 Runtime 或 Builder 合同可继续使用。
- 升级前停止流量和任务、备份私有数据与配置，并同步发布 Eval、Builder 和 Runtime。需要继续处理的业务重新导入 Skill、生成标准需求、绑定 Result 并重新验收；不转换旧任务或继承旧结论。操作步骤见[协议升级](production-deployment.md#协议升级)。
- 统一流程支持整体改造、需求导出 / 交付回填 / 版本绑定与任务验收。Builder 交付须完成标准生命周期准入，不能用旧逐 Tool 或旧单成员验收替代。

## 运维或修改时从哪里查

| 现象/需求 | 先查 | 主要代码 |
| --- | --- | --- |
| 服务启动/停止失败 | supervisor、SCM/systemd、预检 | deploy/run.mjs、deploy/lib/settings.mjs、平台 manage 脚本 |
| API 鉴权、500、请求超时 | x-request-id、request_failed | src/service/server.ts、src/service/logging.ts |
| 任务忙、重复提交、取消和重启 | taskId、attemptId、operation 事件 | tasks/application/task-service.ts |
| 找不到源码、生成/修复失败 | agentRunId、agent_process_*、私有任务证据 | tasks/infrastructure/task-agent.ts、migration-agent-runner.ts、bundle_agent.py |
| 能力/模型/容量不兼容 | runtime-check、Runtime capabilities | tasks/infrastructure/task-runtime.ts、shared/contracts/runtime-skills.ts |
| 验收执行失败 | runId + caseId、runtime_session_* | task-acceptance.ts、runtime-launcher.ts、worker.py、session.py |
| Judge 超时/格式/判定问题 | migration_judge_*、judgeRequestId、保护目录中的理由 | tasks/infrastructure/task-agent.ts、openai-compatible-model.ts |
| 下载拒绝/通过状态失效 | 当前候选、配置、测试集、环境摘要 | task-export.ts、domain/task-model.ts |
| 单阶段 UI 修改 | 对应 *Stage.tsx | web/src/features/migration/ |
| 升级后旧入口 404 | 协议升级说明、当前任务 schemaVersion | migration-task-routes.ts、tasks/infrastructure/task-repository.ts |

## 配置责任

| 配置 | 读取位置 | 生效方式 |
| --- | --- | --- |
| API 地址、数据目录、访问令牌 | src/service/config.ts；部署预检在 deploy/lib/settings.mjs | 重启 API |
| 迁移 Python、模型别名、迭代/模型预算 | migration-agent-runner.ts、task-agent.ts、Python model_config.py | 更新服务环境后重启 API；新任务尝试生效 |
| Judge 地址、密钥、超时、出口代理 | config.ts、openai-compatible-model.ts | 更新服务环境后重启 API |
| Runtime 模型配置文件、进程配置 | integrations/openjiuwen | 重启 Runtime |
| 每任务模型、环境、执行超时、入口、工具权限 | 统一任务 Runtime 阶段 | 保存配置后重新验收 |

部署 dotenv 是数据，不能 shell source。模型凭据不放任务表单或日志。并发和存储是进程内协调：单个数据目录只允许一个 API 写入，当前不支持共享目录多副本。整组操作的进程并发上限为 2，API/Runtime 执行超时和停机清理时限各自独立。

任务从首次异步存储操作之前登记生命周期，覆盖排队、RUNNING 落盘、执行与终态持久化；取消按 taskId 中止并等待这些操作，服务关闭拒绝新操作并等待所有已登记操作结束。重复请求分别跟踪登记过程，不覆盖原执行的归属；登记失败释放已预留容量，取消后不会再启动 Agent 或联合验收。

## 修改后的验证入口

- `pnpm check`：Node、示例、Web 类型。
- `pnpm test`：领域、接口、旧协议拒绝、架构、日志与 Runtime 合同回归；登记阶段取消/关闭见 `tests/migration-task-lifecycle-race.test.ts`。
- `pnpm test:ui:migration`：实际浏览器/API，确定性 Agent/Runtime/Judge 端口，验证失败→修复→重验；不作为真实模型效果证据。
- `MIGRATION_LIVE_MEMBERS=1` 或 `3` 配合 `pnpm test:ui:migration:live`：同一个 UI 测试入口验证单/多成员，使用真实 Agent、Runtime、Judge，报告明确记录 memberCount。私有环境变量和启动方式见生产部署文档。
- Python `test_bundle_runtime`：无 ZIP 的说明与资源装载、成员清单、二进制资源、冻结候选校验，包括单成员集合。

生产部署验收和这次工作树测试需分开记录；测试成功不会自动替换正在运行的 Windows/WSL 服务。

完整业务验收完成后，使用 `node scripts/verify-migration-log-correlation.mjs REPORT_DIRECTORY API_LOG` 检查实际请求、进程、Runtime 会话和 Judge 事件能否按持久化 ID 串联；审计输出只含 ID 和计数。`pnpm test:ui:migration:imports` 单独覆盖单文件、混合批量失败、整工程路径和窄屏导入。原 bundle 命名测试命令继续可用，但不代表旧 HTTP 协议仍受支持；旧路由拒绝及历史文件不被修改由 `tests/migration-task-compatibility.test.ts` 验证。

统一交付复用 `domain/migration-export-safety.ts` 的凭据检查，拒绝 `.env`、私钥及明显硬编码凭据；不会为了通过导出而静默删除候选文件或改变冻结摘要。复用内部实现不意味着开放旧任务导出入口。

Builder 产出的 Runtime 如何登记及标准协议支持范围，见 [Builder 接入](runtime-builder-integration.md)。
