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

Skill 迁移统一使用 `runtime_launcher`：测试环境只登记 Launcher Base URL 及访问凭据引用，通过 `/v1/runtime-capabilities` 发现模型和能力。迁移页面不再展示固定 `/execute` Runtime，也不再从本地配置文件投影兼容入口。MCP 从静态环境绑定迁移到每次任务的配置快照；左右两侧分别创建实例，逐题无历史执行，最后删除，Runtime 提供 TTL 兜底。已有 `runtime_http` 记录仍可读取，普通评测入口也暂时保留，但不能用于新建 Skill 迁移验证或优化。

当前协议支持同步或异步启动状态、幂等创建、取消/失败回收、同源 URL 检查、完整 zip 资产传输、受限候选 MCP 包启动及 SSE 执行证据。远程 Launcher 必须使用 HTTPS；本机回环地址允许 HTTP。OpenJiuwen 参考实现不接受外部 MCP URL，只启动本次 Skill 包内经过绑定的候选 MCP。

本批为打通自建 Runtime 先支持服务端到 Launcher 的 `secrets.inline`。秘密值不进入环境登记、运行配置、实例状态或证据，Runtime 在执行副本中注入并统一脱敏；后续再扩展密钥引用/一次性凭据模式。协议细节见 `docs/runtime-launcher-protocol.md`。

## 第三批：Issue #6 后续重构（尚未实现）

1. 迁移记录 Zod、Repository、显式升级与特征测试。
2. 为历史迁移记录提供显式升级；同步替换其余旧流程测试。
3. 迁移 use case、评测工厂/执行器及其他 HTTP 路由拆分。
4. 统一其余前端 DTO/client、Python 生命周期及 TS/Python 契约验证。

普通评测仍可能使用的 `runtime_http` 不属于本批删除范围。两个 Issue 保持打开，不以本批 PR 自动关闭。

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
