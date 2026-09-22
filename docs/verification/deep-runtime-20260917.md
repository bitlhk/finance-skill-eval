# DeepAgent 测试 Runtime 接入验证

锁定框架：OpenJiuwen 0.1.17.post1。修改的是平台集成源码，没有修改第三方框架。

测试会话使用 DeepAgent；SkillUseRail 仅加载当前资产和 skill_tool，其他内置 Harness 能力按需求加载。新增 runtimeHarnessBindings.left/right，经运行管理器传递为 candidateHarnessPlugins。插件声明资产摘要、清单、文件集合和工具名称，由框架 load_plugin 加载。插件独立挂载，不复制进 Skill 资料库。

业务 MCP 保留平台 RuntimeContext 的上下文和鉴权 Provider，每次调用生成 Header，业务 arguments 不混入凭证。工具事件和结果摘要保留；修复真实框架工具参数为 JSON 字符串时，引用文件已读取但证据未记录的问题。兼容框架 shell 对已解析解释器路径及引号的首项检查。

## 真实 Runtime HTTP 端到端测试

执行命令：`.venv-openjiuwen/Scripts/python.exe -B scripts/verify-deep-runtime-e2e.py`。

结果：[完整结果](../../reports/deep-runtime-e2e-20260917-204340/result.json)、[左侧流式证据](../../reports/deep-runtime-e2e-20260917-204340/left-stream.json)、[右侧流式证据](../../reports/deep-runtime-e2e-20260917-204340/right-stream.json)。

实际模型为 deepseek-v4-flash。启动独立 HTTP Worker 和 FastMCP 服务，左右两侧分别创建会话：

- Skill 正文及 references/rules.md 经 skill_tool 读取并记录摘要。
- get_balance 实际通过 MCP HTTP 调用；业务身份和 bearer Provider Header 正确，业务输入仅 account_id，余额 1200。
- 原生 BashTool 实际执行包内 fee.py，服务费 2.5。
- 独立交付的自定义 Harness 插件通过 manifest.json 加载，workspace_info 返回 HARNESS_LOADED。
- 两侧最终 JSON 均为 balance=1200、fee=2.5、marker=HARNESS_LOADED；工作区不同。
- 流式工具开始/结束事件完整，凭证未出现在公开证据中；没有调用 read_file 或 command。
- 篡改 Harness 插件摘要的请求在 Worker 返回 HTTP 400。

本次端到端范围是测试 Runtime HTTP 执行链，未运行迁移 Agent 或模型 Judge。

## 回归检查

- Python Runtime 测试 18 项、会话边界测试 4 项通过。
- TypeScript HTTP Runtime、环境配置、上下文配置、迁移回归及迁移 v2 测试共 32 项通过。
- TypeScript 核心编译与类型检查通过。
- 新增插件实际执行、错误摘要、错误工具声明和未声明服务拒绝测试；最后的插件名称完整性检查及内部 SysOperation 配置同步变更，经真实框架插件测试再次通过。
