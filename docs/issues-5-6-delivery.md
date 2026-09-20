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

## 第二批：Issue #5 启动协议（尚未实现）

新增而非覆盖 `runtime_launcher`：登记启动接口及凭据引用，发现模型和能力。MCP 从静态环境绑定迁移到每次任务的配置快照。每侧创建独立实例，逐题无历史执行，最后删除，Runtime 提供 TTL 兜底。

必须一起交付：异步启动、幂等、取消/失败回收、同源 URL 检查、完整资产传输及实际摘要校验、模型/MCP 秘密不出 Runtime、受限的已验证 MCP 包启动。不能仅删掉现有 Worker 的 MCP 白名单。

当前 main 没有 Issue 中提到的 `local-migration-runtimes.ts`、`candidateMcpServices` 等完整实现；后续以实际合并的代码为基线，不假设其已经存在。

## 第三批：Issue #6 后续重构（尚未实现）

1. 迁移记录 Zod、Repository、显式升级与特征测试。
2. 删除 v0.1 执行分支，保留原记录与可追溯升级；同步替换旧流程测试。
3. 迁移 use case、评测工厂/执行器及其他 HTTP 路由拆分。
4. 统一其余前端 DTO/client、Python 生命周期及 TS/Python 契约验证。

不在第一批中删除生产仍可能使用的旧迁移执行入口。两个 Issue 保持打开，不以本批 PR 自动关闭。

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
