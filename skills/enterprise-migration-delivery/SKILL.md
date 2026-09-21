---
name: enterprise-migration-delivery
description: 把已经定好形式的 Tool 交付成平台能起起来并调用的实现——服务或脚本的骨架、硬要求、启动命令与依赖声明。用于改造阶段写实现、让交付物通过编译与契约测试时。
version: 1.0.0
---

# 企业 Skill 迁移：交付形态

Tool 的实现边界遵循 [企业级 Runtime 无关 Skill 规范第 6 节](../../docs/2.0/skill-specification.md#6-tool-怎样做到与-runtime-无关)：可以解析、校验和使用 Runtime 注入的鉴权信息，不负责建立、选择或切换执行身份。业务入参与运行时依赖分开；声明实际消费的依赖，不统一 Credential 类型，不把凭证获取链路整体搬入工具。以下交付规则不改变这一边界。

凭证与调用上下文由 Runtime 通过声明的独立通道注入，不进入模型可填写的业务参数。HTTP 可以使用请求 header；MCP 和脚本的映射须由具体调用契约明确，不强制使用 header 或 headers 字段。注入按调用隔离，不能依赖共享连接或可变全局状态中的身份。Tool 只读取必要内容，按下游契约构造请求，不无差别透传上下文。阶段处理与传输映射设计见 [迁移中的依赖识别与处理](../../docs/2.0/impl/migration-dependency-handling.md)。

这是**改造阶段**的依据：决定已经做完了（形式由人定、语言由平台算），这里只回答"交付出来的东西要长成什么样才能被平台起起来并调用"。

**判断类规则不在这里。** 合规怎么判、可移植性属于哪个状态、该建议 MCP 还是 Script——那些是检查判断阶段的事，属于另一个技能包。改造阶段拿到的是已经作出的决定，不是要重新做的判断。

## 读哪一份

| 你要做的事 | 读哪一份 |
| --- | --- |
| 服务/脚本的骨架、"能被调用"到底意味着什么、各语言的硬要求 | `references/service-templates.md` |

**这些是骨架，不是必须逐字照抄的模板。** 结构、命名、依赖管理由你决定；不能改的只有那几条硬要求——它们是平台能不能起它、能不能验它的前提。

## 交付必须回答的两件事

1. **怎么起它**：启动命令（argv 数组），需要装依赖或构建就先给一次性准备步骤。平台按它把服务真的起起来。
2. **接口动了哪里**：相对基线改了哪些入参出参，每处都要给理由——迁移必然做适配，有理由的改动是正常的。

接口与基线的差异只进报告，不参与通过与否。判通过与否的是**起得来、工具有、调得通**。

## 当前平台交付契约

Script 通过通用 command 执行，不注册为独立业务 Tool，也不支持额外 Runtime 上下文或凭证注入。执行 cwd 是 workspace，Skill 可以在其他目录；脚本使用 Runtime 给出的绝对路径。包内资源基于 __file__ 或 import.meta.url 定位，相对业务文件及产物位于 workspace。不要在交付代码中写死平台部署路径。

业务服务地址、固定超时等 SERVICE_ENV 配置由 MCP 服务从声明的环境变量读取，只在对应子进程启动时提供；工具级 serviceEnvironment 的 key/name 与诊断一致，不写死值、不转成 Header 或业务参数。tools/list 不访问业务接口、不要求真实配置；必需配置缺失时业务调用前明确失败。

MCP 通过每次请求 Header 消费上下文和最终 Credential，业务 Schema 不包含这些隐式依赖；Runtime 负责身份和凭证获取 SDK。交付 JSON 的 runtimeBindings 必须与诊断 key/header 对应，顶层 runtimeToolConfig 确认平台提供的无实际值模板。未知 Provider、类型或企业接入信息不得猜测。平台根据最终包路径生成 Skill 执行指引和包根目录的 runtime-tool-config.template.json；模板的环境变量由执行方提供，不代表实际调用已经通过。

新生成的 Python MCP 服务使用独立包 `fastmcp==2.14.7`，入口导入 `from fastmcp import FastMCP`。通过具名业务函数、类型注解与必要的 Pydantic 约束定义工具，实际发现 Schema 后与基线核对；差异明确记录原因。当前请求的 Header 通过 `fastmcp.server.dependencies.get_http_headers` 读取，不缓存身份，不新增 MCP 鉴权门槛，不将凭证放入函数的业务参数。依赖和启动命令由交付包声明，不依赖平台或 openJiuwen 的安装环境。

## Runtime Harness 边界

本交付步骤只处理 Skill 文档、业务 MCP 和独立 Script。若诊断结果含 `runtimeCapabilities`，说明迁移依赖目标 Runtime 尚未提供的能力；当前流程必须在诊断阶段停止，并交付 `finance.runtime-build-requirements.v1` YAML，不能生成候选 Harness 插件、伪造能力或进入测试。

未来 Runtime Builder 将消费该 YAML，构建并返回可登记的 Runtime 接口。当前仅预留协议边界，不调用不存在的 Builder。ToolBase、ToolResponse、Toolkit、register_tool 等框架注册与返回包装属于迁移适配胶水，应由业务 MCP/Script 的目标框架实现替代，不得误报为 Runtime Harness 改造需求。

## 库依赖分类

诊断 SDK 依赖通过 library 区分 STANDARD_LIBRARY、PACKAGE、CUSTOM_SDK、UNKNOWN，并引用真实 import。标准库由平台运行环境清单核对，不能将本地同名模块标为标准库，也不要求用户上传源码。第三方包声明实际发行名和依赖清单路径，引用声明原文；已声明不等于已安装或导入成功。企业自定义 SDK 仍需实际源码或契约。迁移保留第三方包的版本约束，写入交付依赖清单并通过包内环境运行；不安装标准库的同名第三方包，不借用模型工作区全局安装环境。
