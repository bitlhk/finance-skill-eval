# Runtime 启动与执行协议

Builder 按通用能力需求交付 Runtime。业务 Skill 在创建实例时注入；一个或多个成员均使用同一 `skills[]` 请求，不设置单/多 Skill 模式。当前 Schema 是 `finance.runtime-instance.v1`（新命名空间），不是旧的 `finance.skill-eval.runtime-instance.v1`。旧协议不再接受。

## 交付与能力发现

Builder 返回 `finance.runtime-build-result.v3`，其中的 Launcher 描述使用 `finance.runtime-launcher-descriptor.v2`。描述包括部署身份、制品摘要、能力摘要、服务入口和认证方式，不包含凭据、Skill、Eval 任务或候选版本。

Eval 从已信任的服务调用 `GET /v1/runtime-capabilities`，核对 `finance.runtime-capabilities.v1`、协议版本、平台、能力合同、权限、隔离、容量与摘要，再使用平台自有验证 Skill 完成启动、真实执行和释放。能力声明本身不是运行成功证据。协议字段和正反例见 [合同目录](../contracts/runtime-launcher/README.md)，接入步骤见 [Builder 接入](runtime-builder-integration.md)。

## 固定接口

| 接口 | 用途 |
| --- | --- |
| `GET /v1/runtime-capabilities` | 发现模型、平台、原生能力、特性和容量 |
| `POST /v1/runtime-instances` | 用幂等键创建实例，注入本次 Skill 集合与配置 |
| `GET /v1/runtime-instances/{id}` | 查询准备状态 |
| `POST /v1/runtime-instances/{id}/execute` | 执行案例，返回 JSON evidence 或 SSE 终态 evidence |
| `DELETE /v1/runtime-instances/{id}` | 请求释放并读取显式清理回执 |

HTTP 路径中的 `/v1` 与消息 Schema 独立版本化。远程入口要求 HTTPS，回环地址可用 HTTP；返回的执行地址必须位于已登记入口的同源、同路径范围内。

## 实例输入

`skills[]` 的每个成员包含身份、版本、入口路径、说明、成员摘要及可选资源；共享依赖放 `assets`。纯指令 Skill 不需要工程 ZIP。可选入口指令和 MCP 启动描述均引用已提供的文件。实例同时携带模型、运行配置、超时和必要秘密。

Launcher 校验原始字节、所有成员摘要、`contentDigest`、入口覆盖、路径与文件冲突，以及 `limits.maxSkills`、文件数、字节数和超时容量。不得通过改写换行、猜测入口或拆分请求绕过检查。所有成员在同一实例工作区可被 Agent 发现；装载不等于实际调用，不要求每个案例调用所有成员。

`skill`、`variant`、`bundle` 和旧实例 Schema 在传输边界被拒绝。Eval 的内部资产 ZIP 可以转换为标准集合，但不成为第二种 Runtime 接口。

## 身份与验收

终态 evidence 必须包含正确的 Runtime/模型身份、完整流状态、`contentDigest`、`loadedSkillMembers` 与 `loadedSkills`。工具调用和业务结果由实际执行提供，缺少装载证据不能用模型自述代替。

业务验收冻结 Runtime、Skill/资源、配置、案例和 Judge。输入变化需重新验收；只要 Runtime 能力仍满足需求，就不要求重新构建 Runtime。每个验收案例创建独立实例，案例间不复用会话。可选 `features.multiTurn` 仅表示一个案例内部的原生多轮会话，未声明时拒绝请求。

执行已失败但身份与装载证据可信时，保留真实工具调用和失败信息，可用于开发修复。身份不可信、启动失败或 Judge 失败先排查对应服务，不能据此自动修改 Skill。留出案例不反馈给修复 Agent。

## 释放与部署生命周期

删除响应里的 `deleted` 只表示收到请求。必须取得匹配实例 ID 的 `finance.eval-cleanup-observation.v1`，且状态为 `RELEASED`，才能确认 Launcher 管理范围内的资源已释放。`PENDING` 继续轮询；`FAILED` 或没有回执保留句柄供重试。空响应、204、404 均不能推断释放成功。不自动重放可能已有副作用的案例。

Launcher 同时管理实例 TTL。部署由独立宿主管理，构建进程退出不会停止部署；停止或撤销部署先停止接收实例，再处理在途执行和释放。重启必须核对制品与进程归属，不能把旧 READY 文件当成当前进程已就绪。

## 秘密和可观测性

密钥由接入环境的秘密存储解析。允许的 inline secrets 只用于启动注入，状态、日志、错误、事件和证据都必须脱敏。模型凭据不放入 Builder Result，也不回传浏览器。

标准观察事件使用 `finance.runtime-observation.v1`；保留框架事件名和是否为边界合成事件。可选工具进程、多轮和 MCP 结果通道证据只能在实际支持时声明。缺少可选观察不应伪造成完整证据；验收依赖终态执行证据和声明的基本保证。

关联日志包括 requestId、buildRequestId、deploymentId、artifactSha256、instanceId、taskId、attemptId、runId、caseId；各服务记录自身边界内的标识。Builder 不需要理解 Eval 的任务含义。

## 参考实现

`integrations/openjiuwen/` 提供标准集合 Worker；它按实际能力声明是否支持外部 MCP、多轮或其他特性。Builder 独立宿主和部署操作见 Builder 的 `docs/migration-builder-deployment.md`。契约是通用边界，参考 Worker 的具体框架能力不是所有 Runtime 都必须伪造的能力。
