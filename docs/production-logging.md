# 生产日志与排障

API 输出 JSON 到 stdout，Runtime/迁移子进程摘要输出 JSON 到 stderr，由部署方式托管。默认 info，FINANCE_EVAL_LOG_LEVEL 可调整；默认生产禁止 FINANCE_EVAL_AGENT_DUMP。

| 事件 | 关联信息 | 用途 |
| --- | --- | --- |
| HTTP 请求/完成/request_failed | reqId、method、path、statusCode、responseTime | 鉴权、慢请求、服务错误 |
| service_ready/stopping/stopped/shutdown_timeout | version、workspaceMode、timeoutMs | 启动和有界停机 |
| evaluation_status | runId、status、errorCode | 评测状态变化 |
| bundle_operation_started/finished | taskId、attemptId、kind、status、elapsedMs | 整体迁移/修复/验收 |
| bundle_case_started/finished/failed | taskId、runId、caseId、candidateId、phase | 联合验收逐题定位 |
| agent_process_started/exited/timeout/cancelled/start_failed | stage、runId、assetDigest、pid、exitCode、elapsedMs、stderrBytes、lastErrorType | Agent 进程异常与回收 |
| runtime_session_started/finished/timeout | runId、caseId、pid、terminal、elapsedMs、stderrBytes、lastErrorType | 执行异常摘要 |
| supervisor_started/stopping/exited/force_stop/failed | service、pid、exitCode/code | 外层托管 |

HTTP 请求生成独立 reqId 并返回 x-request-id，不采信外部请求 ID；异步任务使用 taskId/attemptId/runId/caseId，与请求不是同一生命周期。HTTP 日志移除 query、headers、请求体；异常仅保留类别/错误码/状态码，不记录上游 message/stack/cause，Pino 隐式 msg 也在调用边界脱敏。

Runtime stderr 持续排空，只保留最多 8 KiB 尾部用于提取异常类别，累计记录字节数，不复制原始输出。生产 Agent/会话关闭 SDK 文件日志，警告由父进程处理。源码、模型回复、Judge 理由、工具证据仍保存在**受保护业务数据**，不表示这些证据都已脱敏。

## 保留和告警

- systemd：journal 持久化、总量与保留期由主机管理员审查，示例会影响整机。
- Docker：每容器 20 MiB × 10，日志驱动变更后需重建容器。
- Windows：WinSW stdout/stderr 各 20 MiB、10 文件，wrapper 自身日志也纳入容量观察。
- 代理日志、系统日志、业务证据和备份分别设置权限、保留和磁盘告警。

建议监控连续健康失败、重复重启、shutdown_timeout/force_stop、Agent/Runtime 超时、任务失败率、低磁盘空间、备份失败和超过 RPO。当前提供事件与探测命令，未集成外部告警平台或 Prometheus；现场接入后发送一次演练告警。

## 排障

统一迁移新增的关联链：HTTP `x-request-id` → 尝试 `requestId/attemptId` → 迁移进程 `agentRunId`（进程事件中也作为 `runId`）或验收 `runId` → `caseId` → `judgeRequestId`。API 与 Python Runtime 的验收事件使用同一 `runId/caseId`，无需将模型输入写入日志。`migration_judge_started/finished` 记录任务、尝试、运行、案例、Judge 请求 ID、耗时和安全错误类别；具体判定仍在受保护的验收记录。

任务页「任务与排障标识」展示可复制的任务、请求、尝试、Agent 和验收运行 ID。旧记录缺失关联字段时显示未采集，不补造历史追踪 ID。`migration_task_created` 记录创建请求和成员数量。既有 `bundle_operation_*` / `bundle_case_*` 事件名继续保留，现也用于单成员任务，避免已有日志查询失效。

例如生成失败：先用 UI 的 `attemptId` 查 `bundle_operation_finished`，再按该尝试持久化的 `agentRunId` 查 `agent_process_*`；验收失败则用 `runId/caseId` 查 `runtime_session_*` 和 `migration_judge_*`。具体代码入口见 [当前架构导航](current-architecture.md)。

取响应 x-request-id、UI taskId/runId、时间和候选版本，查 HTTP → operation → case → process 事件。stderrBytes 非零但无 terminal 时检查异常类别、退出码、资源和网络；完整证据由授权人员在私有任务目录查看，不复制到公共日志/工单。

如需详细 Agent dump，在隔离复现场景启用，设私有路径、短保留期；默认生产预检拒绝该开关。脱敏测试覆盖已知应用路径，不保证任意第三方扩展、业务脚本或代理永不输出敏感信息，新增工具仍须验收。

## Builder 接入日志

统一任务记录 `migration_builder_requirements_created`、`migration_builder_delivery_started`、`migration_builder_delivery_bound` 和 `migration_builder_delivery_failed`。通过 `taskId`、HTTP `requestId`、`buildRequestId` 关联需求与回填；成功日志提供 `bindingId`、`buildId`、`deploymentId`、`environmentId` 和 `conformanceRunId`。生命周期检查的运行 ID 也保存在交付记录 `evalConformance.runId` 中。日志不打印 Result 正文、源码、模型输入或凭据；详细失败原因在受保护的 API 响应中。
