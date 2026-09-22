# Runtime 执行边界修复

日期：2026-09-17。

Script 不再逐个注册为 LocalFunction。ReActAgent 只注册一个通用 command 能力，在挂载的 Skill 包目录执行 argv，支持业务 stdin，返回退出码和标准输出/错误；不要求输出是 JSON。脚本启动索引通过 runtimeCommandBindings / commandScripts 传递，供包挂载、命令说明及就绪检查使用。旧 runtimeToolBindings / scriptTools 不再接受。

Script 不支持额外 Runtime 注入。命令子进程和技术试运行只继承基础运行环境，不继承平台鉴权配置或业务密钥变量。超时、取消及输出限制会清理命令进程。命令执行仅用于已授权的受信任本地 Skill，工作目录与程序白名单不等同于操作系统沙箱。

runtimeToolConfig.tools 仅配置 MCP。contextBindings 将 Header 名映射到 context 引用，对象等值按 ASCII 安全 JSON 编码；鉴权 Provider 返回 Header。每次 MCP 调用独立构建客户端和 Header，业务 arguments 与 Schema 不混入上下文。上下文与鉴权 Header 冲突、重复 Header、传输 Header 覆盖以及旧 authBindings 明确报错；注入 Header 覆盖静态同名 Header时忽略大小写。

诊断与生成规则同步调整：需要 Runtime 注入的实现推荐 MCP，选择 Script 阻止生成；A4 提示和调用契约移除旧环境变量注入方式。

验证：

- Core/Web TypeScript 检查及 Vite 构建。
- Runtime 配置、HTTP 传递、诊断、迁移和环境相关回归 39 项通过，结果见 reports/runtime-boundary-tests.json。
- Python Runtime 上下文、实际 command 执行、Session 装配及包启动测试共 19 项通过。
- 浏览器诊断补充、Script 不支持注入提示、接口连通、刷新恢复和窄屏布局通过。
- Python 语法及 diff 空白检查通过。

Session 装配测试使用确定性的 Agent 和 MCP 客户端，命令子进程实际执行；另有平台 MCP 技术验证回归实际启动服务并调用。没有执行真实模型的完整 ReAct 命令选择，也没有验证生产企业 Provider。
