# Runtime Launcher v1

测试环境登记的是 Runtime 启动服务，而不是预先启动的 Agent `/execute`。评测服务在运行前发现能力，为左右侧分别创建隔离实例，执行测试集后删除实例。

## Builder 交付边界

外部 Builder 完成部署后返回 `finance.runtime-launcher-descriptor.v1`。该描述只携带部署身份、Launcher 入口、协议版本、认证方式、产物摘要和 capabilities 摘要，不复制模型、默认模型、MCP 支持或资源限制。平台必须调用 `GET /v1/runtime-capabilities` 获取这些动态能力，并校验 Runtime 类型、版本及 RFC 8785 capabilities 摘要后才能接入。

Descriptor 不得携带 token、API Key、模型密钥或 MCP 密钥。`authentication.type=bearer` 仅表达凭据要求，实际凭据由接入环境自己的 secret store 提供。`artifactSha256` 用于追踪 Builder 产物来源，不代表本服务必须下载或直接启动构建包。规范和配套示例位于 `contracts/runtime-launcher/`。

## 固定接口

- `GET /v1/runtime-capabilities`：返回 Runtime 类型、版本、可选模型、默认模型、特性和资源上限。
- `POST /v1/runtime-instances`：接收本轮模型、Skill 完整包、候选 MCP 启动描述、运行配置和秘密，返回实例状态。
- `GET /v1/runtime-instances/{id}`：异步启动时查询状态。
- `POST /v1/runtime-instances/{id}/execute`：接收单个 case，返回 JSON evidence 或 SSE；每个 case 必须是无历史会话。
- `DELETE /v1/runtime-instances/{id}`：立即释放实例。Runtime 仍须用 `expiresAt`/TTL 回收失联实例。

创建请求必须携带 `idempotency-key`。返回的 `executeEndpoint` 只允许位于已登记 Launcher 的同源、同路径范围内。远程 Launcher 必须使用 HTTPS；`localhost` 和回环 IP 可使用 HTTP。

单次执行失败后，Launcher 可以销毁不可继续使用的实例。Eval 串行使用同侧实例，记录该次失败但不重放
该 case（它可能已经产生副作用）；执行下一 case 前先删除旧实例，404 视为已清理，再使用新的幂等键
创建相同配置的隔离实例。清理失败时不创建替代实例，保留句柄供最终清理重试。这个机制不改变业务日期，
也不允许跨 case 复用会话状态。

Skill 同时携带两个摘要：`artifactSha256` 是平台规范文件树的资产身份，用于关联 Variant、运行证据和历史记录；`archiveSha256` 是本次 `archiveBase64` 解码后 ZIP 字节的 SHA-256，用于校验传输完整性。Launcher 必须校验 Variant 与 Skill 的 `artifactSha256` 一致，并独立校验收到的 ZIP 字节匹配 `archiveSha256`，不能用 ZIP 或解包清单重新推导 `artifactSha256`。

`skill.skillFile` 是可选的包内文档入口，相对完整 archive 根目录；省略时为 `SKILL.md`。复合交付包可显式使用 `skill/SKILL.md`，保留同级 MCP 工程。Launcher 必须验证入口是安全的现存 `SKILL.md`、内容等于 `instructions`；`files` 的每一项也必须与 archive 中同路径内容一致，不能混入 Skill 目录相对路径别名。文档中的相对引用以入口所在目录为基准，Script/MCP 启动路径仍相对完整包根目录。根目录包不发送该可选字段，保持已有请求形式；嵌套入口需要接收方同步支持此 v1 可选扩展，不支持者应明确拒绝，不能改包路径或猜测入口。

## 配置与秘密

普通配置随实例快照传递。当前过渡版将敏感的服务环境变量和 Runtime context 值放入：

```json
{"secrets":{"mode":"inline","values":{"mcp.0.API_TOKEN":"..."}}}
```

业务配置只在后端解析，浏览器提交的评测配置仅包含迁移 revision/digest 引用。实例状态、日志事件和最终 evidence 不得返回秘密；Runtime 应在执行前注入，在错误、工具结果和流事件中脱敏。配置摘要包含秘密键名但不包含秘密值，幂等比较仍包含秘密值摘要，避免凭据变化时复用旧实例。

## 已有原生能力复用

`nativeToolNames` 仅说明工具存在；可选 `nativeCapabilities` 为每项已实现能力提供
`capabilityId`、调用名 `name`、输入/输出/错误 Schema 与语义 `contract`，以及权限、副作用、隔离
`constraints`。不公布凭据或宿主路径，不把工具路径约束描述成恶意代码沙箱。

迁移诊断可读取用户选定的已登记 Runtime 在线声明，将源码需求与目标合同对照。完整匹配时保留原需求并
记录复用绑定，不伪造 Builder Result；不同语义、证据不足或明确要求重建时不能复用放行。现阶段接收端采用
保守的合同精确匹配，语义同义但合同不同的情况需要补充诊断，不声称实现任意 JSON Schema 兼容性推理。
匹配后仍需实际工具验证和业务评估。评测、采用前重新核对在线摘要；源码需求或连接变化使旧绑定失效。

该字段是现有 v1 的可选增量，不新增注册版本；严格旧客户端需要先升级 Schema。没有合同的旧 Launcher
仍可使用，但只有工具名不能证明其满足迁移的原生能力需求。

## 可观测契约

跨框架事件遵循 `contracts/runtime-launcher/finance.runtime-observation.v1.schema.json`。Launcher 将框架原生回调映射为稳定的语义 `kind`，并在 `source.nativeEventType` 中保留原始名称；无法取得原生回调时可以生成边界事件，但必须标记 `source.synthesized=true`。经过脱敏的框架原生数据只能放入可选 `native.data`，可移植消费者不得依赖该字段。

Launcher 通过 capabilities 的可选 `observability` 字段声明 `core`、`tool` 或 `detailed` 等级以及实际支持的标准事件。字段缺失表示旧版 Launcher，不能推断为 Tool 级可观测。Builder 新交付的 Launcher 必须声明该字段。

验收只依赖最终 execution evidence 和 `core` 保证；缺失可选事件不得导致验收失败。诊断和优化使用更高等级事件时必须同时记录 Launcher 声明的等级。任何等级都不得输出隐藏思维链、凭证、Authorization Header 或未脱敏的敏感业务值。

执行失败不等于没有证据。Builder 包后端在已加载并核验 Skill/模型配置后发生的循环失败，可返回
`status=failed` 的终态 evidence：保留实际已记录的工具调用、稳定错误码及可选
`metadata.executionBudget.maxAgentIterations`。Launcher 仍须验证模型、Skill、case 文件和配置绑定，
并销毁该实例；SSE 对应 `execution.failed`，不能发送 `execution.completed`。启动前失败或不能验证
身份时仍返回失败错误，不伪造终态证据。`streamCompleted` 只说明证据流已结束，不代表任务成功；
空的部分调用记录不能证明没有调用过工具。循环上限是可选的宿主诊断，不要求其他框架伪造同名能力。
包后端同时记录 `owner=HARNESS`、`changeMechanism=BUILDER_REBUILD`，因为本实现的上限固化在 Runtime
源码中，实例请求和测试 case 均无覆盖入口。归因时应保留实际控制边界，不能把宿主预算误当成测试规则。

## OpenJiuwen 参考实现边界

复用验收使用可选 v1 `features.multiTurn` / case `turns` 和真实会话回执，详细字段见
`contracts/runtime-launcher/README.md`。只有明确声明支持的 Launcher 才可执行；不同案例隔离，
一个案例内的各轮分别调用原生 Agent 并保留该案例的会话、工作区和 MCP 生命周期。
已有本地参考 worker 未声明该能力，不会把多轮请求降级成一次拼接提示。
新实例不是重新部署服务；临时句柄只说明同生命周期的状态传递，不是跨生命周期复用证明。

参考 worker 支持 Skill zip 包和包内候选 MCP，校验压缩包大小、文件数及路径。v1 明确声明 `externalMcp: false`，因此拒绝由请求传入任意外部 MCP URL；模型 API Key 和 Base URL 继续只存在于 Runtime 自己的 `.runtime.local.json` 中。

## 多 Skill 实例扩展

新增可选能力 `features.multiSkill` 和版本化请求
`finance.skill-eval.runtime-instance.v2`。它通过现有实例端点传输完整整组 ZIP
与成员清单，`skill=null`，每个成员作为独立 Skill 装载。
证据需要核验整组摘要和全部成员摘要。旧 v1 单 Skill 请求保持兼容；
未声明能力的 Launcher 不接收整组候选。
详见 [整体迁移说明](multi-skill-migration.md) 和
[v2 JSON Schema](../contracts/runtime-launcher/finance.skill-eval.runtime-instance.v2.schema.json)。
