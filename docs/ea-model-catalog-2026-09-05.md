# EA 模型清单同步与在线验证

## 范围

将本机 EA/JiuwenSwarm `models.list` 中的 12 个模型同步到独立 OpenJiuwen 评测 Runtime，再加入当前火山网关实际列出的 `glm-5.3`、`glm-5.3-flash`。不修改 EA 配置，也不把 EA 自动路由选项当作一个具体模型。

这里的“火山网关”是 EA 已配置的 `volceapi.com` 网关。本轮通过它的 `/models` 和实际工具调用确认两个新模型可用，不据此宣称所有火山方舟账户都已开通。盘古仍使用 EA 配置的华为 MaaS，OpenRouter 模型仍走 OpenRouter，不混用密钥或地址。

## 模型清单

| 模型 | 来源 | 工具闭环验证 |
| --- | --- | --- |
| GLM-5.2 | EA / 火山网关 | 通过 |
| DeepSeek V4 Flash | EA / 火山网关 | 通过 |
| DeepSeek V4 Pro | EA / 火山网关 | 通过 |
| MiniMax M3 | EA / 火山网关 | 通过 |
| Doubao Seed 2.1 Pro | EA / 火山网关 | 通过 |
| HY3 | EA / 火山网关 | 通过 |
| openPangu 2.0 Flash | EA / 华为 MaaS | 通过 |
| Nemotron Nano | EA / OpenRouter | 首次上游繁忙，一次重试通过 |
| Gemma 4 26B A4B | EA / OpenRouter | 两次上游 429 限流，保留清单、暂不可选 |
| Laguna S 2.1 | EA / OpenRouter | 通过 |
| GLM-4.5-Air | EA / OpenRouter | 通过 |
| GPT-5.6 Luna | EA / OpenRouter | 通过 |
| GLM-5.3 | 新增 / 火山网关 | 通过 |
| GLM-5.3-Flash | 新增 / 火山网关 | 通过，在线评测默认 |

以上“通过”指实际 OpenJiuwen -> 只读 MCP 账户查询 -> 模型根据余额作答，不只是 HTTP 200。每项只做一条工程冒烟，不代表所有岗位场景专业质量通过。免费模型仍可能随时限流，失败不静默改用其他模型。

## 接入方式

- 维护脚本 `scripts/sync-ea-models.mjs` 只读调用 EA 的本机模型管理接口；运行期评测不依赖 EA。
- `.runtime.local.json` 保存模型别名到真实上游模型 ID、地址和密钥的绑定，权限 600，不进入 Git。
- `.models.local.json` 保存前端可见的模型名称、服务方和验证状态；不含凭据。
- 服务通过 `FINANCE_EVAL_EXECUTION_CATALOG` 读取目录，本地工作台与公开实例共用同一目录。
- 在线评测默认左右均为 GLM-5.3-Flash；再次同步 EA 清单时保留评测默认值，不被 EA 的默认模型覆盖。出题、GPT-6 Judge 与文本直测配置独立，不随此次默认切换变化。
- Runtime 使用真实上游 ID，不把 `MiniMax M3` 等显示别名直接发送给 API。
- 同一模型 A/B 使用相同评测参数；参数不照搬 EA 对话采样配置。火山/华为与 OpenRouter 的思考开关按服务方分别处理，实际参数写入运行证据。
- 公共 API 保留左右选定的已验证模型，不再强制覆盖为 GLM-5.2；Judge 仍由服务端固定为 Codex `gpt-6-astra`，不随执行模型变化。
- 文本直测仍使用原有单执行模型配置；本轮多模型支持针对在线 OpenJiuwen Runtime。

## 后续同步

```bash
node scripts/sync-ea-models.mjs --apply --extra glm-5.3 --extra glm-5.3-flash
node scripts/verify-runtime-models.mjs
```

同步会把导入目录状态重置为待验证；运行证据写入 `reports/model-verification/`，只在验证后开放对应选项。已有运行中的任务不受目录更新影响。原 Runtime 配置私有备份位于 `data/model-imports/`。

仅重新验证某个模型：

```bash
node scripts/verify-runtime-models.mjs 'Gemma 4 26B A4B'
```

配置启用后目录热读，无需每次重启 Node。首次增加环境变量或修改代码需在无活动任务时重启服务。

## 回归

- TypeScript 46 项测试通过，新增独立 A/B 选择、未配置模型拒绝、参数/凭据隔离及公开 API 选择不被覆盖的用例。
- Python 9 项测试通过，包含别名映射、按服务方构造请求及错误 Provider 拒绝。
- 类型检查与前端构建通过。
- 浏览器脚本 `scripts/verify-model-selection-ui.mjs` 验证 14 个选项、不可用项、桌面/手机布局，并实际发起 GLM-5.3 / GLM-5.3-Flash 同 Skill 对比。
- 完整在线记录 `run-210bd74b-cd42-4e73-8a01-fc4bf663349b`：两侧均装配财富 Skill 2.1.5，左 GLM-5.3、右 GLM-5.3-Flash；执行分别约 76 秒、73 秒，GPT-6 Judge 完成。这是模型对比，不作为 Skill 有无增益的证据。
- UI 验证在隔离公开实例以可信入口头执行，不冒充真实灵感平台用户登录。线上域名健康检查另行验证。
