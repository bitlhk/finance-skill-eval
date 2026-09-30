# Runtime Launcher v1

测试环境登记的是 Runtime 启动服务，而不是预先启动的 Agent `/execute`。评测服务在运行前发现能力，为左右侧分别创建隔离实例，执行测试集后删除实例。

## 固定接口

- `GET /v1/runtime-capabilities`：返回 Runtime 类型、版本、可选模型、默认模型、特性和资源上限。
- `POST /v1/runtime-instances`：接收本轮模型、Skill 完整包、候选 MCP 启动描述、运行配置和秘密，返回实例状态。
- `GET /v1/runtime-instances/{id}`：异步启动时查询状态。
- `POST /v1/runtime-instances/{id}/execute`：接收单个 case，返回 JSON evidence 或 SSE；每个 case 必须是无历史会话。
- `DELETE /v1/runtime-instances/{id}`：立即释放实例。Runtime 仍须用 `expiresAt`/TTL 回收失联实例。

创建请求必须携带 `idempotency-key`。返回的 `executeEndpoint` 只允许位于已登记 Launcher 的同源、同路径范围内。远程 Launcher 必须使用 HTTPS；`localhost` 和回环 IP 可使用 HTTP。

Skill 同时携带两个摘要：`artifactSha256` 是平台规范文件树的资产身份，用于关联 Variant、运行证据和历史记录；`archiveSha256` 是本次 `archiveBase64` 解码后 ZIP 字节的 SHA-256，用于校验传输完整性。Launcher 必须校验 Variant 与 Skill 的 `artifactSha256` 一致，并独立校验收到的 ZIP 字节匹配 `archiveSha256`，不能用 ZIP 或解包清单重新推导 `artifactSha256`。

## 配置与秘密

普通配置随实例快照传递。当前过渡版将敏感的服务环境变量和 Runtime context 值放入：

```json
{"secrets":{"mode":"inline","values":{"mcp.0.API_TOKEN":"..."}}}
```

业务配置只在后端解析，浏览器提交的评测配置仅包含迁移 revision/digest 引用。实例状态、日志事件和最终 evidence 不得返回秘密；Runtime 应在执行前注入，在错误、工具结果和流事件中脱敏。配置摘要包含秘密键名但不包含秘密值，幂等比较仍包含秘密值摘要，避免凭据变化时复用旧实例。

## 可观测契约

跨框架事件遵循 `contracts/runtime-launcher/finance.runtime-observation.v1.schema.json`。Launcher 将框架原生回调映射为稳定的语义 `kind`，并在 `source.nativeEventType` 中保留原始名称；无法取得原生回调时可以生成边界事件，但必须标记 `source.synthesized=true`。经过脱敏的框架原生数据只能放入可选 `native.data`，可移植消费者不得依赖该字段。

Launcher 通过 capabilities 的可选 `observability` 字段声明 `core`、`tool` 或 `detailed` 等级以及实际支持的标准事件。字段缺失表示旧版 Launcher，不能推断为 Tool 级可观测。Builder 新交付的 Launcher 必须声明该字段。

验收只依赖最终 execution evidence 和 `core` 保证；缺失可选事件不得导致验收失败。诊断和优化使用更高等级事件时必须同时记录 Launcher 声明的等级。任何等级都不得输出隐藏思维链、凭证、Authorization Header 或未脱敏的敏感业务值。

## OpenJiuwen 参考实现边界

参考 worker 支持 Skill zip 包和包内候选 MCP，校验压缩包大小、文件数及路径。v1 明确声明 `externalMcp: false`，因此拒绝由请求传入任意外部 MCP URL；模型 API Key 和 Base URL 继续只存在于 Runtime 自己的 `.runtime.local.json` 中。
