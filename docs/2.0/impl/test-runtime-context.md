# 测试 Runtime 上下文与鉴权

运行请求的 `configuration.runtimeToolConfig` 是平台内部执行配置，不是交付产物。
只支持受信任的本地 Runtime HTTP 环境。未配置时保持旧 Script 参数 JSON 和 MCP 静态 headers。
迁移 Agent 暂不生成该配置。

```json
{
  "context": {
    "user": {"type": "object", "value": {"id": "test-user"}},
    "token": {"type": "string", "env": "BUSINESS_TOKEN"}
  },
  "providers": {
    "businessAuth": {"implementation": "bearer", "inputs": {"token": "context.token"}}
  },
  "tools": {
    "balance": {
      "contextBindings": {"X-Business-User": "context.user"},
      "authProvider": "businessAuth"
    }
  }
}
```

每个 context 字段必须指定 type，且 value/env 二选一。环境变量从 Worker 运行环境取值；
string 保留原文本，object/array/number/boolean 按 JSON 解析并校验类型。
引用是 `context.<字段>[.<子字段>]`，缺失引用在执行前报错。字段默认敏感。

MCP 的 contextBindings 左侧是 HTTP Header 名，右侧是 context 引用。字符串直接传入，其他值以 ASCII 安全 JSON 序列化，Tool 根据声明解析。Runtime 每次调用独立生成 Header，业务 arguments 原样传入，工具 Schema 只描述业务入参。
上下文与鉴权 Header 同名（忽略大小写）时拒绝执行；注入值覆盖静态同名 Header。禁止覆盖传输协议 Header。

Script 不注册为独立业务 Tool。仅在 Skill 声明脚本需求时加载框架 BashTool，通过 bash 执行 Skill 指定的脚本，入口使用索引中的绝对路径，业务输入遵循原脚本的调用协议，不要求输出必须为 JSON。command 不再注册。
脚本不接收 contextBindings、authProvider 或额外 Runtime 注入。框架 shell 按 SysOperation 的本地工作目录、命令允许清单及执行限制运行，不是操作系统隔离沙箱。

平台配置使用 runtimeCommandBindings 记录包内脚本和启动命令索引，Worker 接收 commandScripts。它们仅用于包挂载、执行说明与依赖就绪检查，不注册同名工具；旧 runtimeToolBindings/scriptTools 不再接受。

内置 provider：

- `bearer`：inputs.token 返回 Authorization header。
- `headers`：inputs.headers 为 header 对象。

企业 SDK 由管理员在 Worker 的 FINANCE_RUNTIME_CONFIG 文件中注册，不接受运行请求指定任意入口：

```json
{"authProviders": {"enterprise_auth": {"entrypoint": "installed_enterprise_auth:authenticate"}}}
```

函数接收 provider inputs 映射后的 keyword arguments，返回 header 字典，支持同步/异步。
SDK 必须安装到 Worker 环境；token 获取、刷新、签名由该实现负责。每次实际工具调用会调用 provider。
MCP 初始化和工具发现也使用 provider；同一 endpoint 的第一个所选工具用于发现，
该身份需要有工具发现权限。工具执行使用独立映射，避免复用发现身份给其他工具。
provider header 覆盖静态同名 header；不自动新增 MCP 鉴权，不自动转发至下游业务 API。

runtimeToolConfig.tools 仅用于 MCP；旧 authBindings 已移除，需要上下文或凭证注入的脚本应迁移成 MCP。

上下文敏感值及 provider 入参、输出加入公开证据脱敏集合。provider 异常对外只返回通用错误。
实际敏感值优先通过 env 提供：直接 value 会作为测试运行配置由平台保存，不是密钥托管。

验证：锁定版本 SkillUseRail 的资料读取、提示索引与按需 BashTool 实际执行测试，Python 会话与 runtime_context 测试、TypeScript Runtime 配置及运行环境回归测试。

## 执行路径

测试执行器使用锁定版本的 DeepAgent，内部仍由 ReActAgent 执行模型和工具循环。关闭 task loop、plan mode、自动工作区创建和自动工具重试，避免为评估引入额外执行行为。工具调用前后及异常事件由 DeepAgent 转发到内部执行器，平台继续记录流式事件和证据。

Runtime 分别维护 workspace 和 Skill 目录，并把两者绝对路径提供给 Agent。Skill 通过锁定版本的 SkillUseRail 注册 skill_tool 加载，不再将正文直接拼入系统提示，不固定注册自定义 read_file 或 command。include_tools=false、skill_mode=all，仅提供 Skill 索引和 skill_tool，不自动装配 list_skill、文件工具或 shell。

每次执行建立仅含本次资产的临时 Skill 库，完整复制声明的包内文件，以资产正文作为 SKILL.md；skill_tool 使用 skill_name=target-skill，并通过 relative_file_path 按需读取引用资料。该临时库与执行结束一起清理，不扫描宿主其他 Skill。

其他 Harness 工具通过运行配置 runtimeHarnessTools 显式选择（read_file、glob、list_files、bash），HTTP 请求对应 environment.harnessToolNames；平台前置检查将明确选择的 Harness 能力与 MCP 工具分开处理。同名冲突报错，未知能力拒绝加载。声明 commandScripts 时表示 Skill 具有脚本需求，仅按需加载框架 BashTool；没有脚本或显式 shell 需求就没有 shell。脚本索引仍提供包内入口的绝对路径，实际执行使用 bash，不再提供 command 工具。相对业务输入输出路径以 workspace 为基准，脚本自带资源可基于 __file__ 定位。

框架 SysOperation 的 CWD 初始化为 workspace，文件操作启用 sandbox_root 限制，仅允许工作区、资产目录和本次临时 Skill 库；shell 使用 python、python3、uv、node 的命令允许清单。此处为框架的本地执行约束，不是操作系统隔离沙箱。Harness 工具调用通过 Rail Hook 记录工具证据，MCP 上下文与鉴权配置机制保持不变。

Worker 的可信配置支持 workspaceDirectory（外部已有工作区，不清理）、workspaceRoot（每次执行创建临时工作区的父目录）和 skillDirectories（artifactSha256 到已有 Skill 目录的映射；校验已加载文件匹配，不覆盖或删除）。未配置时分别创建两个临时目录，无固定共同目录结构。临时目录在本次执行结束后清理；现阶段未增加文件产物归档，需持久保留文件时配置 workspaceDirectory。

## 自定义 Harness 插件

运行配置 `runtimeHarnessBindings.left/right` 指定对应资产提供的插件，Worker 请求字段为 `environment.candidateHarnessPlugins`：

```json
{
  "assetDigest": "<对应 Skill 资产的 SHA256>",
  "manifestPath": "plugins/company/manifest.json",
  "filePaths": ["plugins/company/manifest.json", "plugins/company/tool.py"],
  "toolNames": ["company_search"]
}
```

插件代码属于交付包中的独立 Runtime 插件，不是 Skill 业务脚本。平台按 filePaths 挂载这些文件；Worker 将声明文件复制到独立临时插件目录，使用框架 `DeepAgent.load_plugin` 加载 manifest.json。摘要必须同时匹配实际资产与请求 variant；清单必须包含在声明文件中，实际加载的工具必须与 toolNames 一致。同名能力、目录越界、缺失文件或摘要不匹配均报错。Harness 插件不能自行引入未声明的 MCP 服务或其他 Skill。

工具清单使用框架格式 `{"packageType":"plugin","id":"company","tools":[{"file":"tool.py","class":"CompanySearchTool"}]}`。class 必须是可以无参数构建的 Python 类，实例为框架 Tool（或已注册实现的 ToolCard）。Tool 子类需要实现 invoke 和 stream。此清单加载器不自动注入平台上下文或鉴权；已有业务 MCP 的 runtimeToolConfig 配置保持原机制。

真实 HTTP Runtime 验证脚本：`.venv-openjiuwen/Scripts/python.exe -B scripts/verify-deep-runtime-e2e.py`。使用已配置真实模型，覆盖左右两次执行、Skill 引用读取、业务鉴权 MCP、原生 BashTool、自定义插件、流式记录、工作区隔离、脱敏和错误摘要拒绝。该脚本不执行迁移 Agent 或模型 Judge。


## MCP 服务启动配置

服务部署配置与按调用上下文分离。诊断的 `CONFIG / RUNTIME / INJECT / SERVICE_ENV` 声明环境变量名、源码消费类型、用途和必需性；实际值沿用平台运行配置存储，用户在诊断依赖卡片直接填写，共用依赖只填一次。实际值不进入 A2/A4 输入，也不进入业务 arguments、请求 Header 或 runtimeToolConfig.context。

迁移 Agent 交付的服务读取声明的环境变量，用工具级 `serviceEnvironment:[{key,name}]` 报告映射。平台校验映射与诊断严格一致。包根目录配置模板 `runtime-tool-config.template.json` 包含 `serviceEnvironment` 声明，不包含实际值。工具公布契约不访问业务服务；必需配置缺失时，业务调用前明确失败。

技术试运行按服务合并其工具所需的配置，传给 Node 启动器的对应子进程，并在验证结束后关闭。完整测试将 revision、候选 digest、configuration digest 的引用保存到 runtimeMcpBindings，不复制配置值到任务快照。Skill 迁移只选择后端 `FINANCE_RUNTIME_CONFIG` 对应的本地 Runtime 及其模型，不读取通用“测试环境”登记。执行时平台校验引用和工具范围，向该本地 Runtime 发送候选 MCP 的启动描述与临时环境值；Python Runtime 为本次执行启动 MCP，只把配置传给对应子进程，并在执行结束后清理。两条路径都不修改全局 process.env / os.environ，prepare 阶段不需要接收业务配置。PORT、PATH 等执行环境变量不能通过服务配置覆盖。外部已部署 MCP 的配置由部署方设置，平台不声称已为它注入环境变量。

修改配置会使原连通、技术验证和完整 Runtime 评估失效；历史记录保留，不能用于当前候选验收或优化。配置实际值缺失不阻塞静态诊断或生成，试运行前必须补齐必需项。
