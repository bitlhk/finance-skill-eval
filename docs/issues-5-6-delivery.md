# 测试环境与模块重构：分批交付

基线：`6b33ea4`（0.4.1），对应 GitHub Issue #5、#6。

## 第一批：兼容链路修复与边界提取

- 环境支持创建、编辑、删除；修改保留 ID 和创建时间。
- 服务端检查绑定存在且属于 MCP，拒绝重复绑定；被引用 MCP 不可删除。
- 创建失败在页面展示，不再出现点击后无反馈的未捕获 Promise。
- OpenJiuwen `/health` 声明 `mcpEndpoints`，预检核对实际接受的 MCP。
- 未升级的 OpenJiuwen 在绑定 MCP 时明确报“无法确认”，不假报执行就绪。
- HTTP 环境路由独立注册，继续走原认证及公开演示权限钩子。
- 环境 Zod/DTO 提取到 `shared/contracts`；旧导出路径继续可用。
- 前端环境 feature 和 API client 从 App 提取。
- 迁移修改由全局队列改为按项目串行；创建去重仍单独串行。
- 锁仅在当前服务进程有效，不声称支持多副本分布式写入。

部署兼容要求：评测服务和 OpenJiuwen Worker 需一起升级；仅升级评测服务，旧 Worker 在有 MCP 绑定时会报不能确认兼容。现有 `/execute` 请求及历史数据未迁移。

## 第二批：Issue #5 启动协议

Skill 迁移与普通评测统一使用 `runtime_launcher`：测试环境登记 Launcher Base URL 及访问凭据引用，通过 `/v1/runtime-capabilities` 发现模型和能力；执行环境负责绑定 Launcher、MCP 与默认模型。固定 `/execute` Runtime、独立执行模型清单以及 `runtime_http` 兼容入口均已删除。左右两侧分别创建实例，逐题无历史执行，最后删除，Runtime 提供 TTL 兜底。

当前协议支持同步或异步启动状态、幂等创建、取消/失败回收、同源 URL 检查、完整 zip 资产传输、受限候选 MCP 包启动及 SSE 执行证据。远程 Launcher 必须使用 HTTPS；本机回环地址允许 HTTP。OpenJiuwen 参考实现不接受外部 MCP URL，只启动本次 Skill 包内经过绑定的候选 MCP。

本批为打通自建 Runtime 先支持服务端到 Launcher 的 `secrets.inline`。秘密值不进入环境登记、运行配置、实例状态或证据，Runtime 在执行副本中注入并统一脱敏；后续再扩展密钥引用/一次性凭据模式。协议细节见 `docs/runtime-launcher-protocol.md`。

## 第三批：Issue #6 模块重构

已完成迁移 domain/application/infrastructure 分层、独立 HTTP routes、共享契约、按 migration ID 串行、旧执行链删除和完整核心字段 Zod 校验。不同 migration 的并发操作互不阻塞。v0.1 记录不自动升级；旧流程的诊断、生成和验证证据不满足新版语义，用户应从原始 Skill 新建迁移，避免把历史状态误判为新版有效结果。

普通评测和 Skill 迁移现已共享同一套 Launcher 与执行环境模型。Issue #6 可在整合 PR 合入后关闭。

## Issue #5 当前边界

已交付 Launcher capabilities/create/status/execute/delete、环境创建/编辑/删除/预检、同步与异步启动、逐题实例、TTL、同源执行端点、包内候选 MCP、受管外部 MCP 绑定、环境变量凭据引用及内联执行秘密脱敏。

Issue #5 仍保持打开：公网任意用户 Runtime 的准入、DNS 解析后的私网/重绑定防护、一次性凭据或密钥引用，以及非参考 Launcher 的互操作验收尚未完成。这些边界不能用已有受管双 Runtime 验证替代。

## 验证

```sh
pnpm check
pnpm test
pnpm build
python -m unittest integrations.openjiuwen.test_model_config integrations.openjiuwen.test_script_process integrations.openjiuwen.test_reference_mcp
node scripts/verify-environment-ui.mjs
FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS=1 node scripts/verify-migration-v2-ui.mjs
```

浏览器脚本使用临时数据及临时端口，结束后回收。可通过 `CHROMIUM_PATH` 指定本机 Chromium。脚本执行许可只为隔离测试夹具开启，不改变生产开关。此批测试不包含外部用户自建 Runtime 启动服务的端到端验收。
