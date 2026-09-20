# 企业 Skill 迁移开发与演示案例

全部使用模拟业务数据。4 个原始包、4 个手工迁移参考包、12 个固定业务目标；
每个案例均支持目标评估和原服务对比。参考包不作为 Agent 迁移成功的证据。

报销包内的 workspace/ 提供首次演示的输入文件，默认从 cwd/workspace 读取。
verify_examples.py 则从包外独立工作区执行同一脚本，传 workspace="."，验证它没有依赖 Skill 目录作为 cwd。

| 案例 | 重点 | 业务分支 |
|---|---|---|
| 01-expense 报销合规 | 无鉴权；脚本自带资源与工作区输入 | 合规、两项违规、文件缺失 |
| 02-balance 员工余额 | 原 Runtime user；缺 auth SDK；对象与 provider 映射 | 成功、越权、账户缺失 |
| 03-procurement 采购审批 | 三工具共享依赖；预算独有部门配置 | 批准、预算不足、供应商停用 |
| 04-refund 退款资格 | 多级调用；分转元；错误与短路 | 成功、状态拒绝、订单缺失 |

每个子目录包含 source/、reference/ 及对应 ZIP，suite.json、targets.json、
original-service.json、diagnosis-expected.json。后三种 JSON 是开发辅助说明，
不是要求平台支持的新上传格式。user.json 仅提供可复制的测试值，不要求上传 JSON。

生成和验证（项目根目录）：

```powershell
python -B acceptance/enterprise-migration-examples/build_examples.py
python -B acceptance/enterprise-migration-examples/verify_examples.py
node --import tsx acceptance/enterprise-migration-examples/verify_formats.mjs
python -B acceptance/enterprise-migration-examples/server.py --port 4327
```

验证会在随机本地端口启动服务，执行原版工具和参考 Script，对照全部目标与业务调用链，
并检查一次真实 SDK provider 配置注入。它不执行迁移 Agent、A2 或在线模型；
完整端到端测试仍需通过平台导入、诊断、补充、生成、评估。

真实 MCP 验证使用项目锁定的 Runtime 环境：

```powershell
.venv-openjiuwen/Scripts/python.exe -B acceptance/enterprise-migration-examples/verify_mcp_examples.py
```

它启动三个参考 MCP 服务，检查 9 个场景、15 次工具调用，并验证模型 schema 不含执行依赖。

演示步骤：

1. 启动 server.py，导入案例 source.zip。
2. 对照 diagnosis-expected.json 检查 A2 的真实诊断。不要将验收清单输入 Agent。
3. 需要 SDK 时上传 supplements/auth_sdk.py；采购案例另补 department_config.py。
4. 在测试配置填 user 对象与业务地址；应用 key 使用环境变量 DEMO_APP_KEY=demo-app。
5. 用 runtime-config.json 作为手工配置参考；目前不假定前端已实现全部配置表单。
6. 在目标评估模式导入 suite.json，用模型 Judge；rubric 描述明确结果，不能用空关键词规则判定通过。
7. 在原服务对比模式按 original-service.json 配置真实请求和 data.businessResult 提取。

Worker SDK 注册：把 supplements/ 加入 Worker 的 PYTHONPATH，并将
worker-auth-providers.json 中 authProviders 合入私有 Worker 配置。不要覆盖模型或 MCP 配置。
当前 Runtime 的上下文和鉴权配置用于 MCP HTTP headers。
案例 02–04 的 reference/mcp/server.py 从 headers 读取执行依赖，Tool schema 只含业务参数；
scripts/ 是手工调试和业务逻辑核对入口，不通过平台注入鉴权。

原服务接口执行原始源码和预定业务工作流，模拟原 Runtime 提供身份/配置/SDK；
它不是原企业线上 Agent，也不使用 LLM。请求的 user 仅用于模拟切换测试身份。
因此本案例可验证工具语义、调用链和服务适配；无法证明真实旧 Agent 的推理行为等价。

案例 01 使用 Script，案例 02–04 的参考部署使用 MCP。当前 Runtime 不支持 Script 上下文／鉴权注入，
所以采购预算工具不推荐选择依赖注入的 Script；混合形式需额外明确 Script 的独立执行依赖契约。
MCP 参考启动：在包内运行 `uv run --project mcp python mcp/server.py`，端口由 PORT 指定。
