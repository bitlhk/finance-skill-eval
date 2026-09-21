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

## OpenJiuwen 参考实现边界

参考 worker 支持 Skill zip 包和包内候选 MCP，校验压缩包大小、文件数及路径。v1 明确声明 `externalMcp: false`，因此拒绝由请求传入任意外部 MCP URL；模型 API Key 和 Base URL 继续只存在于 Runtime 自己的 `.runtime.local.json` 中。
