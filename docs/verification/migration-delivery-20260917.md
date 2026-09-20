# A4 第一版交付契约修复

日期：2026-09-17。

A4 输入增加 deliveryContract，明确 Script command、独立 workspace、Runtime 提供脚本绝对路径、包内资源定位和 MCP Header 注入边界。同步修改 A4 提示词与 enterprise-migration-delivery 交付说明。

A4 返回 MCP runtimeBindings 及配套 runtimeToolConfig，平台核对工具授权、语言、编译/契约结果、依赖 key/Header 与配置一致性。不接受模型新增实际身份值、Credential 或其他 Provider 获取逻辑来替换已确认契约。Header 绑定仍是 Agent 的声明，最终实际行为需要后续技术调用验证。

生成包追加与最终入口对应的 Skill 执行说明，并在包根目录提供 runtime-tool-config.template.json。模板通过环境变量提供最终上下文或 Credential，不包含用户保存的真实测试配置。消费类型或映射未知时记录 unresolved，不能把模板视为完整可执行接入。企业鉴权 SDK 和动态凭证获取仍留在受信任 Runtime Provider，此版本没有自动生成或安装企业 Provider。

Script 的 A4 契约测试和生成后技术试运行均使用与 Skill 包分离的 cwd、入口及项目绝对路径。包资源错误地依赖 cwd 时测试失败；需要 Runtime 注入的 Script 拒绝执行。MCP 依赖值缺失时完成启动/发现等可验证检查，实际调用明确待验证。

验证：

- Core/Web TypeScript 检查及 Core 构建通过。
- 交付、诊断、迁移、语言、回归和测试集共 49 项通过；机器结果为 reports/migration-delivery-tests.json。
- Python 迁移契约、命令执行、包启动、Session 装配和路径检查 22 项通过。
- 实际脚本使用独立 cwd 和包资源绝对定位；错误的 cwd 资源读取被拒绝。
- Python 语法及 diff 空白检查通过。

A2/A4 使用固定夹具，Session 使用确定性 Agent/MCP 客户端；命令和部分 MCP 技术验证实际执行。未验证真实大模型本轮生成质量或生产企业 Provider。
